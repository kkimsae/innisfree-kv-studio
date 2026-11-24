import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Textures = { front?: string; side?: string; top?: string; back?: string; left?: string; bottom?: string };

export function BoxPreview({ widthMm, heightMm, depthMm, textures }: { widthMm: number; heightMm: number; depthMm: number; textures: Textures }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || !(widthMm > 0) || !(heightMm > 0) || !(depthMm > 0)) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(element.clientWidth, element.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, element.clientWidth / Math.max(1, element.clientHeight), 0.01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const width = widthMm / 100;
    const height = heightMm / 100;
    const depth = depthMm / 100;
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const materials = [0, 1, 2, 3, 4, 5].map((index) => materialFor(index, textures));
    const mesh = new THREE.Mesh(geometry, materials);
    scene.add(mesh);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(width, depth) * 1.4, 48),
      new THREE.MeshStandardMaterial({ color: "#e7e1d8", roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -height / 2;
    scene.add(ground);
    scene.add(new THREE.AmbientLight("#fff4e8", 0.85));
    const key = new THREE.DirectionalLight("#ffffff", 1.4);
    key.position.set(-2, 3, 2);
    scene.add(key);
    const radius = Math.max(width, height, depth) * 2.4;
    camera.position.set(radius * 0.85, radius * 0.55, radius);
    controls.target.set(0, 0, 0);
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    const onResize = () => {
      if (!element) return;
      camera.aspect = element.clientWidth / Math.max(1, element.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      geometry.dispose();
      materials.forEach((material) => {
        material.map?.dispose();
        material.dispose();
      });
      ground.geometry.dispose();
      const groundMaterial = ground.material;
      if (Array.isArray(groundMaterial)) groundMaterial.forEach((material) => material.dispose());
      else groundMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [widthMm, heightMm, depthMm, textures.front, textures.side, textures.top, textures.back, textures.left, textures.bottom]);

  return (
    <div className="box-preview">
      <div ref={host} className="box-canvas" />
      <p>{widthMm} × {heightMm} × {depthMm} mm</p>
      <p className="muted">없는 면은 미확인으로 둡니다. 사진을 돌려 새 면을 만들지 않습니다.</p>
    </div>
  );
}

function materialFor(index: number, textures: Textures) {
  const key = (["side", "left", "top", "bottom", "front", "back"] as const)[index];
  const url = textures[key];
  if (!url) return unseenMaterial();
  const texture = new THREE.TextureLoader().load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.72, metalness: 0 });
}

function unseenMaterial() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.MeshStandardMaterial({ color: "#d9d3c7" });
  ctx.fillStyle = "#d9d3c7";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "#b7b0a4";
  ctx.strokeRect(10, 10, 236, 236);
  ctx.fillStyle = "#5c564e";
  ctx.font = "28px 'Noto Sans KR', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("미확인 면", 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 });
}
