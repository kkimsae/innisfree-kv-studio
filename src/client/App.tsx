import { useEffect, useRef, useState } from "react";
import type { AssetRecord, Concept, Job, Project, ProjectSummary, SceneItem, ValidationReport } from "../domain/types";
import {
  applyConcept,
  cancelJob,
  createDemo,
  createProject,
  createRow,
  createSet,
  deleteRow,
  deleteSet,
  exportFile,
  getJob,
  getPlan,
  getProject,
  getStatus,
  layoutScene,
  listProjects,
  onSaveState,
  patchAsset,
  patchProject,
  patchRow,
  patchSceneItem,
  patchSet,
  renderProject,
  restorePackage,
  revise,
  redo,
  undo,
  uploadAsset,
  uploadBackground,
  validateProject,
  type Bundle,
  type ApiError,
} from "./api";
import { BoxMapper } from "./BoxMapper";

type Screen = "home" | "studio";

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [status, setStatus] = useState<{ aiConfigured?: boolean; missing?: string[] } | null>(null);
  const [save, setSave] = useState("대기");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => onSaveState((state) => setSave(state === "saving" ? "저장 중" : state === "saved" ? "저장됨" : state === "error" ? "저장 실패" : "대기")), []);
  useEffect(() => {
    void refreshHome();
    void getStatus().then((value) => setStatus(value as { aiConfigured?: boolean; missing?: string[] })).catch(() => undefined);
  }, []);

  async function refreshHome() {
    const result = await listProjects();
    setProjects(result.projects);
  }

  async function openProject(id: string) {
    setError("");
    const result = await getProject(id);
    setBundle(result.bundle);
    setScreen("studio");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>INNISFREE <span>KV</span> Studio</strong>
          <em>월간 캠페인 히어로</em>
        </div>
        {bundle && <span className="project-name">{bundle.project.name}</span>}
        <div className="top-actions">
          <span className="save-state">{save}</span>
          {screen === "studio" && <button className="ghost" onClick={() => { setScreen("home"); void refreshHome(); }}>프로젝트</button>}
        </div>
      </header>
      {screen === "home" || !bundle ? (
        <Home
          projects={projects}
          error={error}
          onError={setError}
          onOpen={(next) => { setBundle(next); setNotice(""); setScreen("studio"); }}
          onOpenId={(id) => void openProject(id).catch((reason) => setError(messageOf(reason)))}
        />
      ) : (
        <Studio
          bundle={bundle}
          status={status}
          error={error}
          notice={notice}
          onError={setError}
          onNotice={setNotice}
          onBundle={setBundle}
        />
      )}
    </div>
  );
}

function Home({ projects, error, onError, onOpen, onOpenId }: {
  projects: ProjectSummary[];
  error: string;
  onError: (value: string) => void;
  onOpen: (bundle: Bundle) => void;
  onOpenId: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [brief, setBrief] = useState("");

  async function create() {
    onError("");
    try {
      const result = await createProject({ name, campaignMonth: month, outputWidth: width, outputHeight: height, brief });
      onOpen(result.bundle);
    } catch (reason) {
      onError(messageOf(reason));
    }
  }

  async function demo() {
    onError("");
    try {
      const result = await createDemo();
      onOpen(result.bundle);
    } catch (reason) {
      onError(messageOf(reason));
    }
  }

  async function restore(file: File) {
    onError("");
    try {
      const result = await restorePackage(file);
      onOpen(result.bundle);
    } catch (reason) {
      onError(messageOf(reason));
    }
  }

  return (
    <main className="home">
      <section className="home-form panel">
        <h1>한 달의 히어로를 구성합니다</h1>
        <p className="muted">제품 사진과 박스 도면은 그대로 두고, 배치와 배경만 바꿉니다.</p>
        {error && <p className="error">{error}</p>}
        <label className="field">프로젝트 이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder="3월 그린티" /></label>
        <label className="field">캠페인 월<input value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <div className="button-row">
          <label className="field">가로<input type="number" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
          <label className="field">세로<input type="number" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
        </div>
        <label className="field">브리프<textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={4} /></label>
        <div className="button-row">
          <button className="primary" onClick={() => void create()}>프로젝트 만들기</button>
          <button className="ghost" onClick={() => void demo()}>데모 열기</button>
          <label className="ghost">패키지 복원<input type="file" accept=".zip,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void restore(file); }} /></label>
        </div>
      </section>
      <section className="project-list panel">
        <h2>최근 프로젝트</h2>
        {projects.length === 0 && <p className="muted">아직 프로젝트가 없습니다.</p>}
        {projects.map((project) => (
          <button key={project.id} className="project-button" onClick={() => onOpenId(project.id)}>
            <strong>{project.name}</strong>
            <div className="muted">{project.campaignMonth} · {project.outputWidth}×{project.outputHeight}{project.demo ? " · 데모" : ""}</div>
          </button>
        ))}
      </section>
    </main>
  );
}

function Studio({ bundle, status, error, notice, onError, onNotice, onBundle }: {
  bundle: Bundle;
  status: { aiConfigured?: boolean; missing?: string[] } | null;
  error: string;
  notice: string;
  onError: (value: string) => void;
  onNotice: (value: string) => void;
  onBundle: (bundle: Bundle) => void;
}) {
  const project = bundle.project;
  const [tab, setTab] = useState<"sets" | "assets">("sets");
  const [right, setRight] = useState<"plan" | "scene" | "review">("plan");
  const [mapper, setMapper] = useState(false);
  const [stamp, setStamp] = useState(Date.now());
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof getPlan>>["plan"] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [report, setReport] = useState<ValidationReport | null>(bundle.validation);
  const [limits, setLimits] = useState<string[] | null>(null);
  const [pendingFormat, setPendingFormat] = useState("png");
  const [progress, setProgress] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; pointerX: number; pointerY: number } | null>(null);

  useEffect(() => {
    void getPlan(project.id).then((result) => setPlan(result.plan)).catch(() => undefined);
  }, [project.id, project.items, project.outputWidth, project.outputHeight]);

  const selectedItem = project.items.find((item) => item.id === selected) ?? null;

  async function run(work: () => Promise<{ bundle: Bundle } | { bundle?: Bundle }>) {
    onError("");
    try {
      const result = await work();
      if (result.bundle) {
        onBundle(result.bundle);
        setStamp(Date.now());
      }
    } catch (reason) {
      onError(messageOf(reason));
    }
  }

  async function render() {
    await run(async () => {
      const result = await renderProject(project.id);
      setStamp(Date.now());
      return result;
    });
  }

  async function exportWith(format: string, acknowledge: boolean) {
    onError("");
    try {
      const file = await exportFile(project.id, format, acknowledge);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
      setLimits(null);
    } catch (reason) {
      const api = reason as ApiError;
      const details = api.data?.details as { warnings?: Array<{ message: string }> } | undefined;
      if (api.status === 409 && details?.warnings) {
        setPendingFormat(format);
        setLimits(details.warnings.map((warning) => warning.message));
      } else {
        onError(messageOf(reason));
      }
    }
  }

  async function start(url: string) {
    onError("");
    try {
      const result = await fetch(url, { method: "POST" });
      const data = await result.json();
      if (!result.ok) throw Object.assign(new Error(data.message), { status: result.status });
      setJob(data.job);
      const finished = await poll(data.job.id);
      setJob(finished);
      const fresh = await getProject(project.id);
      onBundle(fresh.bundle);
      if (finished.status === "failed") onError(finished.error || "작업을 끝내지 못했습니다.");
    } catch (reason) {
      onError(messageOf(reason));
    }
  }

  function contentBox() {
    const element = image.current;
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    const ratio = element.naturalWidth / Math.max(1, element.naturalHeight);
    const boxRatio = bounds.width / Math.max(1, bounds.height);
    if (ratio > boxRatio) {
      const height = bounds.width / ratio;
      return { left: bounds.left, top: bounds.top + (bounds.height - height) / 2, width: bounds.width, height };
    }
    const width = bounds.height * ratio;
    return { left: bounds.left + (bounds.width - width) / 2, top: bounds.top, width, height: bounds.height };
  }

  return (
    <main className="studio">
      <div className="workspace">
        <aside className="rail">
          <div className="tabs">
            <button className={tab === "sets" ? "active" : ""} onClick={() => setTab("sets")}>구색</button>
            <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>자료</button>
          </div>
          {error && <p className="error">{error}</p>}
          {notice && <p className="banner">{notice}</p>}
          {tab === "sets" ? (
            <Sets bundle={bundle} onBundle={onBundle} onError={onError} onMap={() => setMapper(true)} />
          ) : (
            <Assets assets={bundle.assets} progress={progress} onProgress={setProgress} onChanged={async () => onBundle((await getProject(project.id)).bundle)} onError={onError} />
          )}
        </aside>
        <section className="stage">
          {project.demo && <div className="banner" style={{ margin: "12px 16px 0" }}>데모 예시입니다. 승인된 이니스프리 아트워크가 아닙니다.</div>}
          <div className="stage-toolbar">
            <button className="primary" onClick={() => void run(() => layoutScene(project.id))}>구색 기준으로 배치</button>
            <button className="ghost" onClick={() => void render()}>미리보기</button>
            <label className="ghost">배경 올리기
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void run(async () => {
                  const result = await uploadBackground(project.id, file, setProgress);
                  setStamp(Date.now());
                  return result;
                });
              }} />
            </label>
            <span className="muted">{project.outputWidth}×{project.outputHeight}</span>
          </div>
          {progress > 0 && progress < 1 && <div className="progress"><span style={{ width: `${progress * 100}%` }} /></div>}
          <div className="preview-wrap">
            <img ref={image} src={`/api/projects/${project.id}/preview.png?t=${stamp}`} alt="히어로 미리보기" onError={(event) => { (event.target as HTMLImageElement).style.visibility = "hidden"; }} onLoad={(event) => { (event.target as HTMLImageElement).style.visibility = "visible"; }} />
            {plan && image.current && plan.items.map((item) => (
              <button
                key={item.id}
                className={`hit ${selected === item.id ? "selected" : ""}`}
                style={hitStyle(item, plan, image.current)}
                onPointerDown={(event) => {
                  const scene = project.items.find((entry) => entry.id === item.id);
                  if (!scene) return;
                  drag.current = { id: item.id, x: scene.x, y: scene.y, pointerX: event.clientX, pointerY: event.clientY };
                  setSelected(item.id);
                  (event.target as HTMLElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const current = drag.current;
                  const box = contentBox();
                  if (!current || !box || current.id !== item.id) return;
                  const dx = (event.clientX - current.pointerX) / box.width;
                  const dy = (event.clientY - current.pointerY) / box.height;
                  const scene = project.items.find((entry) => entry.id === item.id);
                  if (!scene) return;
                  scene.x = Math.min(1.2, Math.max(-0.2, current.x + dx));
                  scene.y = Math.min(1.2, Math.max(-0.2, current.y + dy));
                  onBundle({ ...bundle, project: { ...project, items: [...project.items] } });
                }}
                onPointerUp={() => {
                  const current = drag.current;
                  drag.current = null;
                  const scene = project.items.find((entry) => entry.id === item.id);
                  if (!current || !scene) return;
                  void run(() => patchSceneItem(scene.id, { x: scene.x, y: scene.y }));
                }}
              />
            ))}
          </div>
        </section>
        <aside className="rail">
          <div className="tabs">
            <button className={right === "plan" ? "active" : ""} onClick={() => setRight("plan")}>방향</button>
            <button className={right === "scene" ? "active" : ""} onClick={() => setRight("scene")}>장면</button>
            <button className={right === "review" ? "active" : ""} onClick={() => setRight("review")}>검증</button>
          </div>
          {right === "plan" && (
            <PlanPanel
              bundle={bundle}
              status={status}
              job={job}
              onCancel={() => job && void cancelJob(job.id)}
              onAnalyze={() => void start(`/api/projects/${project.id}/analyze`)}
              onConcepts={() => void start(`/api/projects/${project.id}/concepts`)}
              onBackground={() => void start(`/api/projects/${project.id}/background/generate`)}
              onApply={(id) => void run(() => applyConcept(project.id, id))}
            />
          )}
          {right === "scene" && (
            <ScenePanel
              project={project}
              item={selectedItem}
              prompt={prompt}
              onPrompt={setPrompt}
              onPatch={(body) => selectedItem && void run(() => patchSceneItem(selectedItem.id, body))}
              onProject={(body) => void run(() => patchProject(project.id, body))}
              onRevise={() => void run(async () => {
                const result = await revise(project.id, prompt);
                onNotice(result.notes.join(" "));
                setStamp(Date.now());
                return result;
              })}
            />
          )}
          {right === "review" && (
            <ReviewPanel
              report={report}
              status={status}
              onValidate={async () => {
                const result = await validateProject(project.id);
                setReport(result.report);
              }}
              onReview={() => void start(`/api/projects/${project.id}/visual-review`)}
              onExport={(format) => void exportWith(format, false)}
            />
          )}
        </aside>
      </div>
      <footer className="history">
        <button className="ghost" onClick={() => void run(() => undo(project.id))}>실행 취소</button>
        <button className="ghost" onClick={() => void run(() => redo(project.id))}>다시 실행</button>
        {bundle.revisions.slice(0, 8).map((revision) => (
          <article key={revision.id} className="history-card">
            <strong>{revision.prompt || "직접 수정"}</strong>
            <div className="muted">{new Date(revision.createdAt).toLocaleString("ko-KR")}</div>
          </article>
        ))}
      </footer>
      {mapper && (
        <BoxMapper
          assets={bundle.assets}
          templates={bundle.templates}
          onClose={() => setMapper(false)}
          onSaved={async () => {
            setMapper(false);
            onBundle((await getProject(project.id)).bundle);
          }}
        />
      )}
      {limits && (
        <div className="modal">
          <div className="panel" style={{ padding: 20, maxWidth: 460 }}>
            <h2>내보내기 전에 확인할 점</h2>
            {limits.map((item) => <p key={item}>{item}</p>)}
            <div className="button-row">
              <button className="ghost" onClick={() => setLimits(null)}>취소</button>
              <button className="primary" onClick={() => void exportWith(pendingFormat, true)}>이해하고 내보내기</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Sets({ bundle, onBundle, onError, onMap }: { bundle: Bundle; onBundle: (bundle: Bundle) => void; onError: (value: string) => void; onMap: () => void }) {
  const [name, setName] = useState("");
  const assets = bundle.assets.filter((asset) => asset.mediaType === "product");
  async function act(work: () => Promise<{ bundle: Bundle }>) {
    try { onBundle((await work()).bundle); } catch (reason) { onError(messageOf(reason)); }
  }
  return (
    <div className="stack">
      <button className="ghost" onClick={onMap}>박스 PDF 매핑</button>
      <div className="button-row">
        <input value={name} placeholder="세트 이름" onChange={(event) => setName(event.target.value)} />
        <button className="primary" onClick={() => void act(() => createSet(bundle.project.id, name))}>추가</button>
      </div>
      {bundle.project.sets.map((set) => (
        <article key={set.id} className="card" style={{ padding: 10 }}>
          <strong>{set.displayName}</strong>
          <label className="field">박스
            <select value={set.boxTemplateId ?? ""} onChange={(event) => void act(() => patchSet(set.id, { boxTemplateId: event.target.value || null }))}>
              <option value="">선택</option>
              {bundle.templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.widthMm}×{template.heightMm}×{template.depthMm}</option>)}
            </select>
          </label>
          {set.rows.map((row) => (
            <div key={row.id} className="button-row">
              <select value={row.role} onChange={(event) => void act(() => patchRow(row.id, { role: event.target.value }))}>
                <option value="box">박스</option>
                <option value="full-size">본품</option>
                <option value="sample">샘플</option>
                <option value="other">기타</option>
              </select>
              <input type="number" value={row.requiredQuantity} style={{ width: 64 }} onChange={(event) => void act(() => patchRow(row.id, { requiredQuantity: Number(event.target.value) }))} />
              {row.role !== "box" && (
                <select value={row.assetId ?? ""} onChange={(event) => void act(() => patchRow(row.id, { assetId: event.target.value || null }))}>
                  <option value="">제품</option>
                  {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename}</option>)}
                </select>
              )}
              <button className="danger" onClick={() => void act(() => deleteRow(row.id))}>삭제</button>
            </div>
          ))}
          <div className="button-row">
            <button className="ghost" onClick={() => void act(() => createRow(set.id, { role: "sample", requiredQuantity: 1, productName: "새 제품" }))}>행 추가</button>
            <button className="danger" onClick={() => void act(() => deleteSet(set.id))}>세트 삭제</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function Assets({ assets, progress, onProgress, onChanged, onError }: { assets: AssetRecord[]; progress: number; onProgress: (value: number) => void; onChanged: () => Promise<void>; onError: (value: string) => void }) {
  return (
    <div className="stack">
      <p className="muted">원본은 바꾸지 않습니다. 자르기와 크기만 따로 저장합니다.</p>
      <label className="primary" style={{ textAlign: "center" }}>파일 올리기
        <input type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf,.pdf" onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void uploadAsset(file, onProgress).then(() => onChanged()).catch((reason) => onError(messageOf(reason)));
        }} />
      </label>
      {assets.map((asset) => (
        <div key={asset.id} className="asset">
          <div className="checker">{asset.mediaType === "product" && <img src={`/api/assets/${asset.id}/preview.png`} alt="" />}</div>
          <div>
            <strong>{asset.originalFilename}</strong>
            <div className="muted">{asset.mediaType === "pdf" ? "PDF" : `${asset.pixelWidth ?? "?"}×${asset.pixelHeight ?? "?"}`}</div>
            {asset.mediaType === "product" && (
              <label className="field">실제 높이 mm
                <input type="number" defaultValue={asset.physicalHeightMm ?? ""} onBlur={(event) => {
                  const value = event.target.value ? Number(event.target.value) : null;
                  void patchAsset(asset.id, { physicalHeightMm: value }).then(() => onChanged()).catch((reason) => onError(messageOf(reason)));
                }} />
              </label>
            )}
          </div>
        </div>
      ))}
      {progress > 0 && progress < 1 && <div className="progress"><span style={{ width: `${progress * 100}%` }} /></div>}
    </div>
  );
}

function PlanPanel({ bundle, status, job, onAnalyze, onConcepts, onBackground, onApply, onCancel }: {
  bundle: Bundle;
  status: { aiConfigured?: boolean; missing?: string[] } | null;
  job: Job | null;
  onAnalyze: () => void;
  onConcepts: () => void;
  onBackground: () => void;
  onApply: (id: string) => void;
  onCancel: () => void;
}) {
  const ai = status?.aiConfigured;
  return (
    <div className="stack">
      {!ai && <p className="banner">AI 기능은 OPENAI_API_KEY가 있어야 합니다. 배치, 배경 업로드, 수정, 내보내기는 그대로 사용할 수 있습니다.</p>}
      <button className="ghost" disabled={!ai || job?.status === "running"} onClick={onAnalyze}>패키지 분석</button>
      <button className="ghost" disabled={!ai || job?.status === "running"} onClick={onConcepts}>콘셉트 제안</button>
      <button className="ghost" disabled={!ai || job?.status === "running"} onClick={onBackground}>배경만 생성</button>
      {job?.status === "running" && <button className="danger" onClick={onCancel}>취소</button>}
      {bundle.analysis && (
        <article className="card" style={{ padding: 10 }}>
          <strong>관찰</strong>
          <p>{bundle.analysis.artDirection.summary || "확정된 관찰이 없습니다."}</p>
          {bundle.analysis.unresolved.map((item) => <p key={item} className="muted">미확정: {item}</p>)}
        </article>
      )}
      {bundle.concepts.map((concept) => <ConceptCard key={concept.id} concept={concept} onApply={() => onApply(concept.id)} />)}
    </div>
  );
}

function ConceptCard({ concept, onApply }: { concept: Concept; onApply: () => void }) {
  return (
    <article className="card" style={{ padding: 10 }}>
      <img src={`/api/concepts/${concept.id}/preview.png`} alt="" style={{ width: "100%", borderRadius: 8 }} onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = "none"; }} />
      <strong>{concept.name}</strong>
      <p className="muted">{concept.rationale}</p>
      <button className="primary" onClick={onApply}>이 구성 적용</button>
    </article>
  );
}

function ScenePanel({ project, item, prompt, onPrompt, onPatch, onProject, onRevise }: {
  project: Project;
  item: SceneItem | null;
  prompt: string;
  onPrompt: (value: string) => void;
  onPatch: (body: Record<string, unknown>) => void;
  onProject: (body: Record<string, unknown>) => void;
  onRevise: () => void;
}) {
  return (
    <div className="stack">
      <label className="field">수정 문장
        <textarea value={prompt} rows={3} onChange={(event) => onPrompt(event.target.value)} placeholder="제품 배치는 유지하고 배경만 조금 밝게" />
      </label>
      <button className="primary" onClick={onRevise}>수정 적용</button>
      <label className="field">위쪽 여백
        <input type="number" step="0.01" value={project.camera.topMargin} onChange={(event) => onProject({ camera: { ...project.camera, topMargin: Number(event.target.value) } })} />
      </label>
      <label className="field">받침대 높이
        <input type="number" step="0.01" value={project.pedestal.height} onChange={(event) => onProject({ pedestal: { ...project.pedestal, height: Number(event.target.value) } })} />
      </label>
      {item ? (
        <>
          <p>{item.id.slice(0, 8)}</p>
          <label className="field">가로 위치<input type="number" step="0.01" value={item.x} onChange={(event) => onPatch({ x: Number(event.target.value) })} /></label>
          <label className="field">세로 위치<input type="number" step="0.01" value={item.y} onChange={(event) => onPatch({ y: Number(event.target.value) })} /></label>
          <label className="field">균일 크기<input type="number" step="0.01" value={item.scale} onChange={(event) => onPatch({ scale: Number(event.target.value) })} /></label>
        </>
      ) : <p className="muted">미리보기에서 제품을 선택하면 수치를 바꿀 수 있습니다.</p>}
    </div>
  );
}

function ReviewPanel({ report, status, onValidate, onReview, onExport }: {
  report: ValidationReport | null;
  status: { aiConfigured?: boolean } | null;
  onValidate: () => Promise<void>;
  onReview: () => void;
  onExport: (format: string) => void;
}) {
  return (
    <div className="stack">
      <button className="primary" onClick={() => void onValidate()}>구성 검증</button>
      <button className="ghost" disabled={!status?.aiConfigured} onClick={onReview}>시각 리뷰</button>
      {report && (
        <article className="card" style={{ padding: 10 }}>
          <strong>{report.passed ? "구성 오류 없음" : "수정이 필요합니다"}</strong>
          <p className="muted">{report.note}</p>
          {report.errors.map((issue) => <p key={issue.message} className="error">{issue.message}</p>)}
          {report.warnings.map((issue) => <p key={issue.message}>{issue.message}</p>)}
          {report.visualFlags.map((issue) => <p key={issue.message} className="muted">{issue.message}</p>)}
        </article>
      )}
      <div className="button-row">
        <button className="ghost" onClick={() => onExport("png")}>PNG</button>
        <button className="ghost" onClick={() => onExport("jpg")}>JPG</button>
        <button className="ghost" onClick={() => onExport("background")}>배경</button>
        <button className="ghost" onClick={() => onExport("subjects")}>제품</button>
        <button className="ghost" onClick={() => onExport("shadow")}>그림자</button>
        <button className="ghost" onClick={() => onExport("package")}>패키지</button>
      </div>
    </div>
  );
}

function hitStyle(item: { left: number; top: number; width: number; height: number }, plan: { width: number; height: number }, image: HTMLImageElement | null) {
  if (!image || !image.naturalWidth) return { display: "none" };
  const bounds = image.getBoundingClientRect();
  const parent = image.parentElement?.getBoundingClientRect();
  if (!parent) return { display: "none" };
  const ratio = image.naturalWidth / image.naturalHeight;
  const boxRatio = bounds.width / Math.max(1, bounds.height);
  let left = bounds.left;
  let top = bounds.top;
  let width = bounds.width;
  let height = bounds.height;
  if (ratio > boxRatio) {
    height = bounds.width / ratio;
    top += (bounds.height - height) / 2;
  } else {
    width = bounds.height * ratio;
    left += (bounds.width - width) / 2;
  }
  const scaleX = width / plan.width;
  const scaleY = height / plan.height;
  return {
    left: left - parent.left + item.left * scaleX,
    top: top - parent.top + item.top * scaleY,
    width: item.width * scaleX,
    height: item.height * scaleY,
  };
}

async function poll(id: string): Promise<Job> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await getJob(id);
    if (result.job.status !== "running" && result.job.status !== "queued") return result.job;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return (await getJob(id)).job;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "요청을 끝내지 못했습니다.";
}
