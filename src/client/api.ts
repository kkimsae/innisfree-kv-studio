import type { Analysis, AssetRecord, BoxTemplate, Concept, Job, Project, ProjectSummary, RevisionRecord, ValidationReport } from "../domain/types";

export type Bundle = {
  project: Project;
  assets: AssetRecord[];
  templates: BoxTemplate[];
  concepts: Concept[];
  analysis: Analysis | null;
  revisions: RevisionRecord[];
  revisionCursor: number;
  jobs: Job[];
  validation: ValidationReport | null;
  exports: unknown[];
};

export type ApiError = Error & { status?: number; data?: { error?: string; message?: string; details?: unknown } };

type SaveState = "idle" | "saving" | "saved" | "error";
const listeners = new Set<(state: SaveState) => void>();

export function onSaveState(listener: (state: SaveState) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(state: SaveState) {
  listeners.forEach((listener) => listener(state));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  emit("saving");
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.message || "요청을 끝내지 못했습니다.") as ApiError;
      error.status = response.status;
      error.data = data;
      emit("error");
      throw error;
    }
    emit("saved");
    return data as T;
  } catch (error) {
    if (!(error as ApiError).status) emit("error");
    throw error;
  }
}

export function getStatus() {
  return request<{ aiConfigured: boolean; missing: string[]; models: Record<string, string> }>("/api/status");
}

export function listProjects() {
  return request<{ projects: ProjectSummary[] }>("/api/projects");
}

export function createProject(body: { name: string; campaignMonth: string; outputWidth: number; outputHeight: number; brief: string }) {
  return request<{ bundle: Bundle }>("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function createDemo() {
  return request<{ bundle: Bundle; message: string }>("/api/demo-project", { method: "POST" });
}

export function getProject(id: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${id}`);
}

export function patchProject(id: string, body: Record<string, unknown>) {
  return request<{ bundle: Bundle }>(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function createSet(projectId: string, displayName: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${projectId}/sets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName }) });
}

export function patchSet(id: string, body: Record<string, unknown>) {
  return request<{ bundle: Bundle }>(`/api/sets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function deleteSet(id: string) {
  return request<{ bundle: Bundle }>(`/api/sets/${id}`, { method: "DELETE" });
}

export function createRow(setId: string, body: Record<string, unknown>) {
  return request<{ bundle: Bundle }>(`/api/sets/${setId}/rows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function patchRow(id: string, body: Record<string, unknown>) {
  return request<{ bundle: Bundle }>(`/api/rows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function deleteRow(id: string) {
  return request<{ bundle: Bundle }>(`/api/rows/${id}`, { method: "DELETE" });
}

export function uploadAsset(file: File, onProgress?: (ratio: number) => void) {
  return upload<{ asset: AssetRecord }>("/api/assets", file, onProgress);
}

export function patchAsset(id: string, body: Record<string, unknown>) {
  return request<{ asset: AssetRecord }>(`/api/assets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function renderPdf(id: string) {
  return request<{ pageCount: number; pages: Array<{ page: number; width: number; height: number; url: string }> }>(`/api/assets/${id}/pdf/render`, { method: "POST", body: "{}" });
}

export function saveTemplate(body: Record<string, unknown>, id?: string) {
  return request<{ template: BoxTemplate }>(id ? `/api/box-templates/${id}` : "/api/box-templates", {
    method: id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function layoutScene(projectId: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${projectId}/scene/layout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reflow: true }) });
}

export function patchSceneItem(id: string, body: Record<string, unknown>) {
  return request<{ bundle: Bundle }>(`/api/scene-items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function getPlan(projectId: string) {
  return request<{ plan: { width: number; height: number; items: Array<{ id: string; name: string; left: number; top: number; width: number; height: number; role: string }> } }>(`/api/projects/${projectId}/plan`);
}

export function renderProject(projectId: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${projectId}/render`, { method: "POST", body: "{}" });
}

export function validateProject(projectId: string) {
  return request<{ report: ValidationReport }>(`/api/projects/${projectId}/validate`, { method: "POST", body: "{}" });
}

export function revise(projectId: string, prompt: string) {
  return request<{ bundle: Bundle; notes: string[] }>(`/api/projects/${projectId}/revisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

export function undo(projectId: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${projectId}/undo`, { method: "POST" });
}

export function redo(projectId: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${projectId}/redo`, { method: "POST" });
}

export function uploadBackground(projectId: string, file: File, onProgress?: (ratio: number) => void) {
  return upload<{ bundle: Bundle }>(`/api/projects/${projectId}/background`, file, onProgress);
}

export function startJob(url: string) {
  return request<{ job: Job }>(url, { method: "POST" });
}

export function getJob(id: string) {
  return request<{ job: Job }>(`/api/jobs/${id}`);
}

export function cancelJob(id: string) {
  return request<{ job: Job }>(`/api/jobs/${id}/cancel`, { method: "POST" });
}

export async function exportFile(projectId: string, format: string, acknowledgeLimits: boolean) {
  emit("saving");
  const response = await fetch(`/api/projects/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format, acknowledgeLimits }),
  });
  if (response.status === 409) {
    emit("saved");
    const data = await response.json();
    const error = new Error(data.message) as ApiError;
    error.status = 409;
    error.data = data;
    throw error;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    emit("error");
    throw new Error(data?.message || "내보내지 못했습니다.");
  }
  emit("saved");
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = match ? decodeURIComponent(match[1]) : `export.${format === "jpg" ? "jpg" : format === "package" ? "zip" : "png"}`;
  return { blob, filename };
}

export function restorePackage(file: File) {
  return upload<{ bundle: Bundle }>("/api/restore", file);
}

export function applyConcept(projectId: string, conceptId: string) {
  return request<{ bundle: Bundle }>(`/api/projects/${projectId}/concepts/${conceptId}/apply`, { method: "POST" });
}

function upload<T>(url: string, file: File, onProgress?: (ratio: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.set("file", file);
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      if (xhr.status >= 200 && xhr.status < 300) {
        emit("saved");
        resolve(data as T);
      } else {
        emit("error");
        reject(new Error(data?.message || "올리지 못했습니다."));
      }
    };
    xhr.onerror = () => {
      emit("error");
      reject(new Error("연결이 끊겼습니다. 다시 시도해 주세요."));
    };
    emit("saving");
    xhr.send(form);
  });
}
