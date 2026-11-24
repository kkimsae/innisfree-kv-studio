import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CAMERA, DEFAULT_CROP, DEFAULT_LIGHTING, DEFAULT_PEDESTAL, clone } from "../domain/defaults.js";
import type {
  Analysis,
  AssetRecord,
  AssortmentRow,
  BoxTemplate,
  Concept,
  ConceptPayload,
  Crop,
  Job,
  Lighting,
  PanelMapping,
  Pedestal,
  ProductSet,
  Project,
  ProjectSummary,
  RevisionRecord,
  Role,
  SceneItem,
  ShadowSettings,
  ValidationReport,
  ViewingAngle,
  VisualState,
} from "../domain/types.js";
import { openDatabase, type StudioDb } from "./db.js";
import { HttpError } from "./errors.js";
import { safeJoin } from "./files.js";

const now = () => new Date().toISOString();

export class Store {
  readonly db: StudioDb;

  constructor(readonly dataDir: string) {
    this.db = openDatabase(dataDir);
    this.failRunningJobs("서버가 다시 시작되어 진행 중 작업을 멈췄습니다. 저장된 프로젝트는 그대로입니다.");
  }

  absolute(relativePath: string) {
    return safeJoin(this.dataDir, relativePath);
  }

  close() {
    this.db.close();
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM product_sets s WHERE s.project_id = p.id) AS set_count,
        (SELECT COUNT(*) FROM assortment_rows r JOIN product_sets s ON s.id = r.set_id WHERE s.project_id = p.id) AS row_count
      FROM projects p
      ORDER BY p.updated_at DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      campaignMonth: String(row.campaign_month),
      outputWidth: Number(row.output_width),
      outputHeight: Number(row.output_height),
      demo: Boolean(row.demo),
      updatedAt: String(row.updated_at),
      setCount: Number(row.set_count),
      rowCount: Number(row.row_count),
    }));
  }

  createProject(input: {
    id: string;
    name: string;
    campaignMonth: string;
    outputWidth: number;
    outputHeight: number;
    brief?: string;
    constraints?: string;
    demo?: boolean;
  }) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO projects (
        id, name, campaign_month, output_width, output_height, brief, constraints_text,
        lighting_json, pedestal_json, camera_json, demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.campaignMonth,
      input.outputWidth,
      input.outputHeight,
      input.brief ?? "",
      input.constraints ?? "",
      JSON.stringify(DEFAULT_LIGHTING),
      JSON.stringify(DEFAULT_PEDESTAL),
      JSON.stringify(DEFAULT_CAMERA),
      input.demo ? 1 : 0,
      timestamp,
      timestamp,
    );
    this.db.prepare(`INSERT INTO revision_state (project_id, cursor_index) VALUES (?, 0)`).run(input.id);
    return this.requireProject(input.id);
  }

  requireProject(id: string) {
    const project = this.getProject(id);
    if (!project) throw new HttpError(404, "프로젝트를 찾지 못했습니다.");
    return project;
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const sets = this.setsFor(id);
    return {
      id: String(row.id),
      name: String(row.name),
      campaignMonth: String(row.campaign_month),
      outputWidth: Number(row.output_width),
      outputHeight: Number(row.output_height),
      brief: String(row.brief),
      constraints: String(row.constraints_text),
      selectedConceptId: row.selected_concept_id ? String(row.selected_concept_id) : null,
      backgroundAssetId: row.background_asset_id ? String(row.background_asset_id) : null,
      backgroundLocked: Boolean(row.background_locked),
      backgroundGenerated: Boolean(row.background_generated),
      lighting: parseJson(String(row.lighting_json), DEFAULT_LIGHTING),
      pedestal: parseJson(String(row.pedestal_json), DEFAULT_PEDESTAL),
      camera: parseJson(String(row.camera_json), DEFAULT_CAMERA),
      demo: Boolean(row.demo),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      sets,
      items: this.itemsFor(id),
    };
  }

  updateProject(id: string, patch: Partial<Pick<Project, "name" | "campaignMonth" | "outputWidth" | "outputHeight" | "brief" | "constraints" | "selectedConceptId" | "backgroundAssetId" | "backgroundLocked" | "backgroundGenerated" | "lighting" | "pedestal" | "camera">>) {
    const current = this.requireProject(id);
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE projects SET
        name = ?, campaign_month = ?, output_width = ?, output_height = ?, brief = ?, constraints_text = ?,
        selected_concept_id = ?, background_asset_id = ?, background_locked = ?, background_generated = ?,
        lighting_json = ?, pedestal_json = ?, camera_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.campaignMonth,
      next.outputWidth,
      next.outputHeight,
      next.brief,
      next.constraints,
      next.selectedConceptId,
      next.backgroundAssetId,
      next.backgroundLocked ? 1 : 0,
      next.backgroundGenerated ? 1 : 0,
      JSON.stringify(next.lighting),
      JSON.stringify(next.pedestal),
      JSON.stringify(next.camera),
      now(),
      id,
    );
    return this.requireProject(id);
  }

  deleteProject(id: string) {
    const tx = this.db.transaction(() => {
      const setIds = this.db.prepare(`SELECT id FROM product_sets WHERE project_id = ?`).all(id) as Array<{ id: string }>;
      for (const set of setIds) this.db.prepare(`DELETE FROM assortment_rows WHERE set_id = ?`).run(set.id);
      this.db.prepare(`DELETE FROM product_sets WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM scene_items WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM concepts WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM analyses WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM revisions WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM revision_state WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM validation_runs WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM exports WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM jobs WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    });
    tx();
  }

  createSet(input: { id: string; projectId: string; displayName: string; boxTemplateId?: string | null; visualEmphasis?: "normal" | "hero" }) {
    this.requireProject(input.projectId);
    const order = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS value FROM product_sets WHERE project_id = ?`).get(input.projectId) as { value: number };
    this.db.prepare(`
      INSERT INTO product_sets (id, project_id, display_name, box_template_id, visual_emphasis, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.projectId, input.displayName, input.boxTemplateId ?? null, input.visualEmphasis ?? "normal", Number(order.value) + 1);
    this.touch(input.projectId);
  }

  updateSet(id: string, patch: { displayName?: string; boxTemplateId?: string | null; visualEmphasis?: "normal" | "hero"; sortOrder?: number }) {
    const current = this.requireSet(id);
    this.db.prepare(`
      UPDATE product_sets SET display_name = ?, box_template_id = ?, visual_emphasis = ?, sort_order = ? WHERE id = ?
    `).run(
      patch.displayName ?? current.displayName,
      patch.boxTemplateId === undefined ? current.boxTemplateId : patch.boxTemplateId,
      patch.visualEmphasis ?? current.visualEmphasis,
      patch.sortOrder ?? current.sortOrder,
      id,
    );
    this.touch(current.projectId);
    if (patch.boxTemplateId !== undefined) {
      this.db.prepare(`
        UPDATE scene_items SET box_template_id = ?
        WHERE assortment_row_id IN (SELECT id FROM assortment_rows WHERE set_id = ? AND role = 'box')
      `).run(patch.boxTemplateId, id);
    }
  }

  deleteSet(id: string) {
    const set = this.requireSet(id);
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM assortment_rows WHERE set_id = ?`).all(id) as Array<{ id: string }>;
      for (const row of rows) this.db.prepare(`DELETE FROM scene_items WHERE assortment_row_id = ?`).run(row.id);
      this.db.prepare(`DELETE FROM assortment_rows WHERE set_id = ?`).run(id);
      this.db.prepare(`DELETE FROM product_sets WHERE id = ?`).run(id);
    });
    tx();
    this.touch(set.projectId);
  }

  createRow(input: { id: string; setId: string; productName: string; capacity?: string; role: Role; requiredQuantity: number; assetId?: string | null }) {
    this.requireSet(input.setId);
    this.db.prepare(`
      INSERT INTO assortment_rows (id, set_id, asset_id, product_name, capacity, role, required_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.setId, input.role === "box" ? null : input.assetId ?? null, input.productName, input.capacity ?? "", input.role, input.requiredQuantity);
    this.touch(this.requireSet(input.setId).projectId);
  }

  updateRow(id: string, patch: Partial<Pick<AssortmentRow, "productName" | "capacity" | "role" | "requiredQuantity" | "assetId">>) {
    const current = this.requireRow(id);
    const role = patch.role ?? current.role;
    const assetId = role === "box" ? null : patch.assetId === undefined ? current.assetId : patch.assetId;
    this.db.prepare(`
      UPDATE assortment_rows SET product_name = ?, capacity = ?, role = ?, required_quantity = ?, asset_id = ? WHERE id = ?
    `).run(
      patch.productName ?? current.productName,
      patch.capacity ?? current.capacity,
      role,
      patch.requiredQuantity ?? current.requiredQuantity,
      assetId,
      id,
    );
    this.touch(this.projectIdForRow(id));
  }

  deleteRow(id: string) {
    const projectId = this.projectIdForRow(id);
    this.db.prepare(`DELETE FROM scene_items WHERE assortment_row_id = ?`).run(id);
    this.db.prepare(`DELETE FROM assortment_rows WHERE id = ?`).run(id);
    this.touch(projectId);
  }

  insertAsset(asset: AssetRecord) {
    this.db.prepare(`
      INSERT INTO assets (
        id, original_filename, source_path, thumbnail_path, media_type, packaging_version, has_transparency,
        pixel_width, pixel_height, physical_width_mm, physical_height_mm, physical_depth_mm, viewing_angle,
        lighting_notes, crop_json, source_sha256, demo_fixture, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id,
      asset.originalFilename,
      asset.sourcePath,
      asset.thumbnailPath,
      asset.mediaType,
      asset.packagingVersion,
      asset.hasTransparency === null ? null : asset.hasTransparency ? 1 : 0,
      asset.pixelWidth,
      asset.pixelHeight,
      asset.physicalWidthMm,
      asset.physicalHeightMm,
      asset.physicalDepthMm,
      asset.viewingAngle,
      asset.lightingNotes,
      JSON.stringify(asset.crop),
      asset.sourceSha256,
      asset.demoFixture ? 1 : 0,
      asset.createdAt,
    );
    return this.requireAsset(asset.id);
  }

  updateAsset(id: string, patch: Partial<Pick<AssetRecord, "packagingVersion" | "physicalWidthMm" | "physicalHeightMm" | "physicalDepthMm" | "viewingAngle" | "lightingNotes" | "crop" | "thumbnailPath">>) {
    const current = this.requireAsset(id);
    const next = {
      ...current,
      packagingVersion: patch.packagingVersion === undefined ? current.packagingVersion : patch.packagingVersion,
      physicalWidthMm: patch.physicalWidthMm === undefined ? current.physicalWidthMm : patch.physicalWidthMm,
      physicalHeightMm: patch.physicalHeightMm === undefined ? current.physicalHeightMm : patch.physicalHeightMm,
      physicalDepthMm: patch.physicalDepthMm === undefined ? current.physicalDepthMm : patch.physicalDepthMm,
      viewingAngle: patch.viewingAngle === undefined ? current.viewingAngle : patch.viewingAngle,
      lightingNotes: patch.lightingNotes === undefined ? current.lightingNotes : patch.lightingNotes,
      crop: patch.crop === undefined ? current.crop : patch.crop,
      thumbnailPath: patch.thumbnailPath === undefined ? current.thumbnailPath : patch.thumbnailPath,
    };
    this.db.prepare(`
      UPDATE assets SET packaging_version = ?, physical_width_mm = ?, physical_height_mm = ?, physical_depth_mm = ?,
        viewing_angle = ?, lighting_notes = ?, crop_json = ?, thumbnail_path = ?
      WHERE id = ?
    `).run(
      next.packagingVersion,
      next.physicalWidthMm,
      next.physicalHeightMm,
      next.physicalDepthMm,
      next.viewingAngle,
      next.lightingNotes,
      JSON.stringify(next.crop),
      next.thumbnailPath,
      id,
    );
    return this.requireAsset(id);
  }

  listAssets() {
    return (this.db.prepare(`SELECT * FROM assets ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>).map(mapAsset);
  }

  requireAsset(id: string) {
    const row = this.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "자산을 찾지 못했습니다.");
    return mapAsset(row);
  }

  insertTemplate(template: BoxTemplate) {
    this.db.prepare(`
      INSERT INTO box_templates (
        id, name, width_mm, height_mm, depth_mm, source_asset_id, source_page, panels_json, revision, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      template.id,
      template.name,
      template.widthMm,
      template.heightMm,
      template.depthMm,
      template.sourceAssetId,
      template.sourcePage,
      JSON.stringify(template.panels),
      template.revision,
      template.notes,
      template.createdAt,
      template.updatedAt,
    );
    return this.requireTemplate(template.id);
  }

  updateTemplate(id: string, patch: Partial<Pick<BoxTemplate, "name" | "widthMm" | "heightMm" | "depthMm" | "sourceAssetId" | "sourcePage" | "panels" | "notes">>) {
    const current = this.requireTemplate(id);
    const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: now() };
    this.db.prepare(`
      UPDATE box_templates SET name = ?, width_mm = ?, height_mm = ?, depth_mm = ?, source_asset_id = ?, source_page = ?,
        panels_json = ?, revision = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.widthMm,
      next.heightMm,
      next.depthMm,
      next.sourceAssetId,
      next.sourcePage,
      JSON.stringify(next.panels),
      next.revision,
      next.notes,
      next.updatedAt,
      id,
    );
    return this.requireTemplate(id);
  }

  listTemplates() {
    return (this.db.prepare(`SELECT * FROM box_templates ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>).map(mapTemplate);
  }

  requireTemplate(id: string) {
    const row = this.db.prepare(`SELECT * FROM box_templates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "박스 템플릿을 찾지 못했습니다.");
    return mapTemplate(row);
  }

  replaceScene(projectId: string, items: SceneItem[]) {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM scene_items WHERE project_id = ?`).run(projectId);
      const insert = this.db.prepare(`
        INSERT INTO scene_items (
          id, project_id, assortment_row_id, asset_id, box_template_id, x, y, scale, layer, surface, shadow_json, visible, rotation_deg
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insert.run(
          item.id,
          projectId,
          item.assortmentRowId,
          item.assetId,
          item.boxTemplateId,
          item.x,
          item.y,
          item.scale,
          item.layer,
          item.surface,
          JSON.stringify(item.shadow),
          item.visible ? 1 : 0,
          item.rotationDeg,
        );
      }
    });
    tx();
    this.touch(projectId);
  }

  updateSceneItem(id: string, patch: Partial<Pick<SceneItem, "x" | "y" | "scale" | "layer" | "shadow">>) {
    const current = this.requireItem(id);
    const next = { ...current, ...patch, rotationDeg: 0 };
    this.db.prepare(`
      UPDATE scene_items SET x = ?, y = ?, scale = ?, layer = ?, shadow_json = ?, rotation_deg = 0 WHERE id = ?
    `).run(next.x, next.y, next.scale, next.layer, JSON.stringify(next.shadow), id);
    this.touch(current.projectId);
    return next;
  }

  readVisual(project: Project): VisualState {
    return {
      items: clone(project.items),
      lighting: clone(project.lighting),
      pedestal: clone(project.pedestal),
      camera: clone(project.camera),
      backgroundAssetId: project.backgroundAssetId,
      backgroundLocked: project.backgroundLocked,
      backgroundGenerated: project.backgroundGenerated,
      selectedConceptId: project.selectedConceptId,
    };
  }

  writeVisual(projectId: string, visual: VisualState) {
    this.replaceScene(projectId, visual.items);
    this.updateProject(projectId, {
      lighting: visual.lighting,
      pedestal: visual.pedestal,
      camera: visual.camera,
      backgroundAssetId: visual.backgroundAssetId,
      backgroundLocked: visual.backgroundLocked,
      backgroundGenerated: visual.backgroundGenerated,
      selectedConceptId: visual.selectedConceptId,
    });
  }

  commitVisual(projectId: string, prompt: string, operations: RevisionRecord["operations"], visual: VisualState) {
    const before = this.readVisual(this.requireProject(projectId));
    const tx = this.db.transaction(() => {
      this.writeVisual(projectId, visual);
      const cursor = this.revisionCursor(projectId);
      this.db.prepare(`DELETE FROM revisions WHERE project_id = ? AND index_num > ?`).run(projectId, cursor);
      const index = cursor + 1;
      this.db.prepare(`
        INSERT INTO revisions (id, project_id, index_num, prompt, operations_json, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), projectId, index, prompt, JSON.stringify(operations), JSON.stringify(before), JSON.stringify(visual), now());
      this.db.prepare(`
        INSERT INTO revision_state (project_id, cursor_index) VALUES (?, ?)
        ON CONFLICT(project_id) DO UPDATE SET cursor_index = excluded.cursor_index
      `).run(projectId, index);
    });
    tx();
    return this.requireProject(projectId);
  }

  undo(projectId: string) {
    const cursor = this.revisionCursor(projectId);
    if (cursor <= 0) throw new HttpError(400, "되돌릴 수정이 없습니다.");
    const row = this.db.prepare(`SELECT before_json FROM revisions WHERE project_id = ? AND index_num = ?`).get(projectId, cursor) as { before_json: string } | undefined;
    if (!row) throw new HttpError(400, "수정 기록을 찾지 못했습니다.");
    this.writeVisual(projectId, parseJson(row.before_json, this.readVisual(this.requireProject(projectId))));
    this.db.prepare(`UPDATE revision_state SET cursor_index = ? WHERE project_id = ?`).run(cursor - 1, projectId);
    return this.requireProject(projectId);
  }

  redo(projectId: string) {
    const cursor = this.revisionCursor(projectId);
    const row = this.db.prepare(`SELECT after_json FROM revisions WHERE project_id = ? AND index_num = ?`).get(projectId, cursor + 1) as { after_json: string } | undefined;
    if (!row) throw new HttpError(400, "다시 적용할 수정이 없습니다.");
    this.writeVisual(projectId, parseJson(row.after_json, this.readVisual(this.requireProject(projectId))));
    this.db.prepare(`UPDATE revision_state SET cursor_index = ? WHERE project_id = ?`).run(cursor + 1, projectId);
    return this.requireProject(projectId);
  }

  listRevisions(projectId: string): RevisionRecord[] {
    const cursor = this.revisionCursor(projectId);
    const rows = this.db.prepare(`SELECT * FROM revisions WHERE project_id = ? AND index_num <= ? ORDER BY index_num`).all(projectId, cursor) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      index: Number(row.index_num),
      prompt: String(row.prompt),
      operations: parseJson(String(row.operations_json), []),
      createdAt: String(row.created_at),
    }));
  }

  revisionCursor(projectId: string) {
    const row = this.db.prepare(`SELECT cursor_index FROM revision_state WHERE project_id = ?`).get(projectId) as { cursor_index: number } | undefined;
    return row?.cursor_index ?? 0;
  }

  insertConcept(concept: Concept) {
    this.db.prepare(`
      INSERT INTO concepts (id, project_id, source, name, rationale, payload_json, preview_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(concept.id, concept.projectId, concept.source, concept.name, concept.rationale, JSON.stringify(concept.payload), concept.previewPath, concept.createdAt);
  }

  updateConceptPreview(id: string, previewPath: string) {
    this.db.prepare(`UPDATE concepts SET preview_path = ? WHERE id = ?`).run(previewPath, id);
  }

  listConcepts(projectId: string): Concept[] {
    const rows = this.db.prepare(`SELECT * FROM concepts WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      source: row.source === "ai" ? "ai" : "manual",
      name: String(row.name),
      rationale: String(row.rationale),
      payload: parseJson<ConceptPayload>(String(row.payload_json), emptyConceptPayload()),
      previewPath: row.preview_path ? String(row.preview_path) : null,
      createdAt: String(row.created_at),
    }));
  }

  requireConcept(id: string) {
    const concept = this.listConceptsOfId(id);
    if (!concept) throw new HttpError(404, "콘셉트를 찾지 못했습니다.");
    return concept;
  }

  insertAnalysis(analysis: Analysis) {
    this.db.prepare(`INSERT INTO analyses (id, project_id, payload_json, created_at) VALUES (?, ?, ?, ?)`).run(
      analysis.id,
      analysis.projectId,
      JSON.stringify({ observed: analysis.observed, artDirection: analysis.artDirection, unresolved: analysis.unresolved }),
      analysis.createdAt,
    );
  }

  latestAnalysis(projectId: string): Analysis | null {
    const row = this.db.prepare(`SELECT * FROM analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`).get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const payload = parseJson<{ observed: Analysis["observed"]; artDirection: Analysis["artDirection"]; unresolved: string[] }>(String(row.payload_json), {
      observed: emptyObserved(),
      artDirection: { summary: "", palette: [], mood: "", avoid: [] },
      unresolved: [],
    });
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      observed: payload.observed,
      artDirection: payload.artDirection,
      unresolved: payload.unresolved,
      createdAt: String(row.created_at),
    };
  }

  saveValidation(projectId: string, report: ValidationReport) {
    this.db.prepare(`INSERT INTO validation_runs (id, project_id, payload_json, created_at) VALUES (?, ?, ?, ?)`).run(
      crypto.randomUUID(),
      projectId,
      JSON.stringify(report),
      now(),
    );
  }

  latestValidation(projectId: string): ValidationReport | null {
    const row = this.db.prepare(`SELECT payload_json FROM validation_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`).get(projectId) as { payload_json: string } | undefined;
    return row ? parseJson<ValidationReport | null>(row.payload_json, null) : null;
  }

  createJob(input: { id: string; projectId: string | null; kind: string }) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO jobs (id, project_id, kind, status, error, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?)
    `).run(input.id, input.projectId, input.kind, timestamp, timestamp);
    return this.requireJob(input.id);
  }

  updateJob(id: string, patch: { status: Job["status"]; error?: string | null; result?: unknown }) {
    this.db.prepare(`UPDATE jobs SET status = ?, error = ?, result_json = ?, updated_at = ? WHERE id = ?`).run(
      patch.status,
      patch.error ?? null,
      patch.result === undefined ? null : JSON.stringify(patch.result),
      now(),
      id,
    );
    return this.requireJob(id);
  }

  requireJob(id: string): Job {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "작업을 찾지 못했습니다.");
    return mapJob(row);
  }

  listJobs(projectId: string) {
    return (this.db.prepare(`SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 12`).all(projectId) as Array<Record<string, unknown>>).map(mapJob);
  }

  countJobs(projectId: string, kind: string, status: Job["status"]) {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND kind = ? AND status = ?`).get(projectId, kind, status) as { count: number };
    return Number(row.count);
  }

  failRunningJobs(message: string) {
    this.db.prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('queued', 'running')`).run(message, now());
  }

  addExport(input: { id: string; projectId: string; format: string; filePath: string; width: number | null; height: number | null; notes: string[] }) {
    this.db.prepare(`
      INSERT INTO exports (id, project_id, format, file_path, width, height, notes_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.projectId, input.format, input.filePath, input.width, input.height, JSON.stringify(input.notes), now());
  }

  listExports(projectId: string) {
    return this.db.prepare(`SELECT id, project_id, format, file_path, width, height, notes_json, created_at FROM exports WHERE project_id = ? ORDER BY created_at DESC`).all(projectId);
  }

  bundle(projectId: string) {
    const project = this.requireProject(projectId);
    return {
      project,
      assets: this.listAssets(),
      templates: this.listTemplates(),
      concepts: this.listConcepts(projectId),
      analysis: this.latestAnalysis(projectId),
      revisions: this.listRevisions(projectId),
      revisionCursor: this.revisionCursor(projectId),
      jobs: this.listJobs(projectId),
      validation: this.latestValidation(projectId),
      exports: this.listExports(projectId),
    };
  }

  private touch(projectId: string) {
    this.db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now(), projectId);
  }

  private setsFor(projectId: string): ProductSet[] {
    const sets = this.db.prepare(`SELECT * FROM product_sets WHERE project_id = ? ORDER BY sort_order, display_name`).all(projectId) as Array<Record<string, unknown>>;
    return sets.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      displayName: String(row.display_name),
      boxTemplateId: row.box_template_id ? String(row.box_template_id) : null,
      visualEmphasis: row.visual_emphasis === "hero" ? "hero" : "normal",
      sortOrder: Number(row.sort_order),
      rows: this.rowsFor(String(row.id)),
    }));
  }

  private rowsFor(setId: string): AssortmentRow[] {
    const rows = this.db.prepare(`SELECT * FROM assortment_rows WHERE set_id = ? ORDER BY role, product_name`).all(setId) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  private itemsFor(projectId: string): SceneItem[] {
    const rows = this.db.prepare(`SELECT * FROM scene_items WHERE project_id = ? ORDER BY layer, id`).all(projectId) as Array<Record<string, unknown>>;
    return rows.map(mapItem);
  }

  private requireSet(id: string) {
    const row = this.db.prepare(`SELECT * FROM product_sets WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "세트를 찾지 못했습니다.");
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      displayName: String(row.display_name),
      boxTemplateId: row.box_template_id ? String(row.box_template_id) : null,
      visualEmphasis: (row.visual_emphasis === "hero" ? "hero" : "normal") as "normal" | "hero",
      sortOrder: Number(row.sort_order),
      rows: this.rowsFor(String(row.id)),
    };
  }

  private requireRow(id: string) {
    const row = this.db.prepare(`SELECT * FROM assortment_rows WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "구색 행을 찾지 못했습니다.");
    return mapRow(row);
  }

  private requireItem(id: string) {
    const row = this.db.prepare(`SELECT * FROM scene_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "장면 객체를 찾지 못했습니다.");
    return mapItem(row);
  }

  private projectIdForRow(rowId: string) {
    const row = this.db.prepare(`
      SELECT s.project_id AS project_id FROM assortment_rows r JOIN product_sets s ON s.id = r.set_id WHERE r.id = ?
    `).get(rowId) as { project_id: string } | undefined;
    if (!row) throw new HttpError(404, "구색 행을 찾지 못했습니다.");
    return row.project_id;
  }

  private listConceptsOfId(id: string): Concept | null {
    const row = this.db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      source: row.source === "ai" ? "ai" : "manual",
      name: String(row.name),
      rationale: String(row.rationale),
      payload: parseJson<ConceptPayload>(String(row.payload_json), emptyConceptPayload()),
      previewPath: row.preview_path ? String(row.preview_path) : null,
      createdAt: String(row.created_at),
    };
  }
}

function mapAsset(row: Record<string, unknown>): AssetRecord {
  return {
    id: String(row.id),
    originalFilename: String(row.original_filename),
    sourcePath: String(row.source_path),
    thumbnailPath: row.thumbnail_path ? String(row.thumbnail_path) : null,
    mediaType: row.media_type as AssetRecord["mediaType"],
    packagingVersion: String(row.packaging_version ?? ""),
    hasTransparency: row.has_transparency === null || row.has_transparency === undefined ? null : Boolean(row.has_transparency),
    pixelWidth: row.pixel_width === null || row.pixel_width === undefined ? null : Number(row.pixel_width),
    pixelHeight: row.pixel_height === null || row.pixel_height === undefined ? null : Number(row.pixel_height),
    physicalWidthMm: row.physical_width_mm === null || row.physical_width_mm === undefined ? null : Number(row.physical_width_mm),
    physicalHeightMm: row.physical_height_mm === null || row.physical_height_mm === undefined ? null : Number(row.physical_height_mm),
    physicalDepthMm: row.physical_depth_mm === null || row.physical_depth_mm === undefined ? null : Number(row.physical_depth_mm),
    viewingAngle: (row.viewing_angle as ViewingAngle) || "unknown",
    lightingNotes: String(row.lighting_notes ?? ""),
    crop: { ...DEFAULT_CROP, ...parseJson<Partial<Crop>>(String(row.crop_json), {}) },
    sourceSha256: String(row.source_sha256),
    demoFixture: Boolean(row.demo_fixture),
    createdAt: String(row.created_at),
  };
}

function mapTemplate(row: Record<string, unknown>): BoxTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    widthMm: Number(row.width_mm),
    heightMm: Number(row.height_mm),
    depthMm: Number(row.depth_mm),
    sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : null,
    sourcePage: row.source_page === null || row.source_page === undefined ? null : Number(row.source_page),
    panels: parseJson<PanelMapping[]>(String(row.panels_json), []),
    revision: Number(row.revision),
    notes: String(row.notes ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRow(row: Record<string, unknown>): AssortmentRow {
  return {
    id: String(row.id),
    setId: String(row.set_id),
    assetId: row.asset_id ? String(row.asset_id) : null,
    productName: String(row.product_name),
    capacity: String(row.capacity ?? ""),
    role: row.role as Role,
    requiredQuantity: Number(row.required_quantity),
  };
}

function mapItem(row: Record<string, unknown>): SceneItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    assortmentRowId: String(row.assortment_row_id),
    assetId: row.asset_id ? String(row.asset_id) : null,
    boxTemplateId: row.box_template_id ? String(row.box_template_id) : null,
    x: Number(row.x),
    y: Number(row.y),
    scale: Number(row.scale),
    layer: Number(row.layer),
    surface: String(row.surface),
    shadow: parseJson<ShadowSettings>(String(row.shadow_json), { opacity: 0.34, blur: 0.02, offsetX: 0.01, offsetY: 0.008 }),
    visible: Boolean(row.visible),
    rotationDeg: Number(row.rotation_deg ?? 0),
  };
}

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    kind: String(row.kind),
    status: row.status as Job["status"],
    error: row.error ? String(row.error) : null,
    result: row.result_json ? parseJson(String(row.result_json), null) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function emptyObserved(): Analysis["observed"] {
  return {
    colors: [],
    motifs: [],
    patternDensity: "",
    typography: "",
    seasonalReferences: [],
    boxRelationships: "",
    visualBalance: "",
  };
}

function emptyConceptPayload(): ConceptPayload {
  return {
    backgroundTreatment: "",
    palette: [],
    pedestalShape: "plank",
    pedestalArrangement: "per-set",
    setOrder: [],
    hierarchy: "equal",
    spacing: "comfortable",
    sampleArrangement: "row",
    lightingDirection: "left",
    lightingSoftness: "soft",
    copyArea: "top",
    angleCompatibility: "",
    unresolved: [],
  };
}

export function removeTree(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function previewFile(dataDir: string, projectId: string, layer: string) {
  return path.join(dataDir, "renders", projectId, `${layer}.png`);
}
