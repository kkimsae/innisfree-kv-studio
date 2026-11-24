import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AssetRecord, BoxTemplate, PanelMapping } from "../domain/types";
import { renderPdf, saveTemplate } from "./api";
import { BoxPreview } from "./BoxPreview";

type Draft = { x: number; y: number; width: number; height: number };

export function BoxMapper({
  assets,
  templates,
  onClose,
  onSaved,
}: {
  assets: AssetRecord[];
  templates: BoxTemplate[];
  onClose: () => void;
  onSaved: (template: BoxTemplate) => void;
}) {
  const pdfs = assets.filter((asset) => asset.mediaType === "pdf");
  const [pdfId, setPdfId] = useState(pdfs[0]?.id ?? "");
  const [pages, setPages] = useState<Array<{ page: number; width: number; height: number; url: string }>>([]);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [panels, setPanels] = useState<PanelMapping[]>([]);
  const [name, setName] = useState("새 박스");
  const [widthMm, setWidthMm] = useState(80);
  const [heightMm, setHeightMm] = useState(120);
  const [depthMm, setDepthMm] = useState(40);
  const [guides, setGuides] = useState(false);
  const [message, setMessage] = useState("");
  const drag = useRef<Draft | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  const current = pages.find((item) => item.page === page);

  function point(event: ReactPointerEvent) {
    const bounds = frame.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  async function loadPages() {
    if (!pdfId) return;
    setMessage("");
    const result = await renderPdf(pdfId);
    setPages(result.pages);
    setPage(result.pages[0]?.page ?? 1);
  }

  function assign(panel: PanelMapping["panel"]) {
    if (!draft || draft.width < 0.01 || draft.height < 0.01) {
      setMessage("PDF 위에서 면을 드래그해 주세요.");
      return;
    }
    const mapping: PanelMapping = {
      panel,
      page,
      x: draft.x,
      y: draft.y,
      width: draft.width,
      height: draft.height,
      rotation: 0,
      inset: { left: 0, top: 0, right: 0, bottom: 0 },
      guidesEmbedded: guides,
      replacementAssetId: null,
      imagePath: null,
    };
    setPanels((currentPanels) => [...currentPanels.filter((item) => item.panel !== panel), mapping]);
  }

  async function save() {
    setMessage("");
    try {
      const result = await saveTemplate({
        name,
        widthMm,
        heightMm,
        depthMm,
        sourceAssetId: pdfId,
        panels: panels.map((panel) => ({ ...panel, guidesEmbedded: guides || panel.guidesEmbedded })),
        guidesEmbedded: guides,
      });
      onSaved(result.template);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  const textures = useMemo(() => {
    const saved = templates.find((template) => template.name === name);
    if (!saved) return {};
    return Object.fromEntries(saved.panels.map((panel) => [panel.panel, `/api/box-templates/${saved.id}/panels/${panel.panel}.png`]));
  }, [templates, name]);

  return (
    <div className="modal" role="dialog" aria-label="박스 매핑">
      <div className="mapper">
        <div className="mapper-stage">
          <div className="button-row">
            <button className="ghost" onClick={onClose}>닫기</button>
            <select value={pdfId} onChange={(event) => setPdfId(event.target.value)}>
              <option value="">PDF 선택</option>
              {pdfs.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename}</option>)}
            </select>
            <button className="primary" onClick={() => void loadPages()} disabled={!pdfId}>페이지 보기</button>
          </div>
          <p className="banner">Illustrator .ai 파일은 읽지 않습니다. 파일을 PDF로 보낸 뒤 올려 주세요.</p>
          {current && (
            <div
              className="page-frame"
              ref={frame}
              onPointerDown={(event) => {
                const start = point(event);
                drag.current = { ...start, width: 0, height: 0 };
              }}
              onPointerMove={(event) => {
                if (!drag.current) return;
                const next = point(event);
                setDraft({
                  x: Math.min(drag.current.x, next.x),
                  y: Math.min(drag.current.y, next.y),
                  width: Math.abs(next.x - drag.current.x),
                  height: Math.abs(next.y - drag.current.y),
                });
              }}
              onPointerUp={() => { drag.current = null; }}
            >
              <img src={current.url} alt={`${page}페이지`} />
              {draft && <div className="draft-rect" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%` }} />}
              {panels.filter((panel) => panel.page === page).map((panel) => (
                <div key={panel.panel} className="panel-rect" style={{ left: `${panel.x * 100}%`, top: `${panel.y * 100}%`, width: `${panel.width * 100}%`, height: `${panel.height * 100}%` }}>{panel.panel}</div>
              ))}
            </div>
          )}
        </div>
        <div className="mapper-side stack">
          <h2>박스 치수</h2>
          <label className="field">이름<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field">가로 mm<input type="number" value={widthMm} onChange={(event) => setWidthMm(Number(event.target.value))} /></label>
          <label className="field">세로 mm<input type="number" value={heightMm} onChange={(event) => setHeightMm(Number(event.target.value))} /></label>
          <label className="field">깊이 mm<input type="number" value={depthMm} onChange={(event) => setDepthMm(Number(event.target.value))} /></label>
          <div className="button-row">
            <button className="ghost" onClick={() => assign("front")}>앞면</button>
            <button className="ghost" onClick={() => assign("side")}>옆면</button>
            <button className="ghost" onClick={() => assign("top")}>윗면</button>
          </div>
          {panels.map((panel) => (
            <label key={panel.panel} className="field">{panel.panel} 회전
              <select value={panel.rotation} onChange={(event) => setPanels((items) => items.map((item) => item.panel === panel.panel ? { ...item, rotation: Number(event.target.value) as PanelMapping["rotation"] } : item))}>
                <option value={0}>0°</option>
                <option value={90}>90°</option>
                <option value={180}>180°</option>
                <option value={270}>270°</option>
              </select>
            </label>
          ))}
          <label className="field"><span><input type="checkbox" checked={guides} onChange={(event) => setGuides(event.target.checked)} /> 재단선·가이드가 포함됨</span></label>
          {guides && <p className="banner">가이드가 아트워크에 포함되어 있습니다. 여백을 주거나 깨끗한 면 이미지를 교체해 주세요. 포장 글자를 자동으로 지우지 않습니다.</p>}
          <button className="primary" onClick={() => void save()}>박스 확정</button>
          {message && <p className="error">{message}</p>}
          <BoxPreview widthMm={widthMm} heightMm={heightMm} depthMm={depthMm} textures={textures} />
        </div>
      </div>
    </div>
  );
}
