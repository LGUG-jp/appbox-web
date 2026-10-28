'use strict';

// モデルや履歴には触れず、作図内容とは独立したSVGレイヤーだけを更新する。
let placementPreviewLayer = null;
let placementPreviewPointer = null;
let placementPreviewType = null;
let placementPreviewObject = null;

function initializePlacementPreview() {
  placementPreviewLayer = svgEl('g', {
    class: 'placement-preview-layer',
    'aria-hidden': 'true',
    'pointer-events': 'none',
    visibility: 'hidden'
  });
  svg.appendChild(placementPreviewLayer);
  const trackPointer = event => {
    placementPreviewPointer = { x: event.clientX, y: event.clientY };
    // ドラッグ中は座標制約を適用した既存ハンドラー側で描画する。
    if (!annotationCreating) refreshPlacementPreview();
  };
  svg.addEventListener('pointerenter', trackPointer);
  svg.addEventListener('pointermove', trackPointer);
  svg.addEventListener('pointerleave', hidePlacementPreview);
  svg.addEventListener('pointercancel', hidePlacementPreview);
  window.addEventListener('blur', hidePlacementPreview);
}

function hidePlacementPreview() {
  placementPreviewPointer = null;
  if (placementPreviewLayer) placementPreviewLayer.setAttribute('visibility', 'hidden');
}

function createPlacementPreviewObject(type) {
  const group = svgEl('g', {});
  let shape;
  if (type === 'person' || type === 'text' || type === 'rect') {
    shape = svgEl('rect', {
      x: 0, y: 0,
      width: type === 'person' ? getNodeDimensions().width : type === 'text' ? 200 : 220,
      height: type === 'person' ? getNodeDimensions().height : type === 'text' ? 64 : 120,
      rx: type === 'person' ? 8 : 0,
      class: 'annotation-create-preview'
    });
  } else if (type === 'ellipse') {
    shape = svgEl('ellipse', { cx: 80, cy: 50, rx: 80, ry: 50, class: 'annotation-create-preview' });
  } else if (type === 'cross') {
    shape = svgEl('path', { d: 'M0 0L70 70M70 0L0 70', class: 'annotation-create-preview cross' });
  } else if (type === 'arrow') {
    shape = svgEl('line', {
      x1: 0, y1: 0, x2: 180, y2: 80,
      class: 'annotation-create-preview arrow',
      'marker-end': 'url(#annotationArrowHead)'
    });
    group.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 4, class: 'annotation-create-start' }));
  }
  if (shape) group.appendChild(shape);
  if (type === 'person' || type === 'text') {
    group.appendChild(svgText(type === 'person' ? '人物' : 'テキスト', 10, 22, 'placement-preview-label'));
  }
  return group;
}

function refreshPlacementPreview() {
  if (!placementPreviewLayer) return;
  const type = personToolActive ? 'person' : annotationTool;
  const rect = svg.getBoundingClientRect();
  const pointer = placementPreviewPointer;
  const inside = pointer && pointer.x >= rect.left && pointer.x < rect.right &&
    pointer.y >= rect.top && pointer.y < rect.bottom;
  if (!type || !inside) {
    placementPreviewLayer.setAttribute('visibility', 'hidden');
    return;
  }
  placementPreviewLayer.setAttribute('visibility', 'visible');
  placementPreviewLayer.setAttribute('transform', `translate(${offsetX}, ${offsetY}) scale(${scale})`);
  const state = annotationCreating;
  if (state && Math.hypot(state.endX - state.startX, state.endY - state.startY) >= 8) {
    placementPreviewType = null;
    placementPreviewObject = null;
    placementPreviewLayer.replaceChildren();
    drawAnnotationCreatePreview(placementPreviewLayer);
    return;
  }
  if (placementPreviewType !== type) {
    placementPreviewType = type;
    placementPreviewObject = createPlacementPreviewObject(type);
    placementPreviewLayer.replaceChildren(placementPreviewObject);
  }
  if (type === 'person') {
    const dimensions = getNodeDimensions();
    const shape = placementPreviewObject.children[0];
    shape.setAttribute('width', dimensions.width);
    shape.setAttribute('height', dimensions.height);
  }
  const point = state ? { x: state.startX, y: state.startY } : clientToWorld(pointer.x, pointer.y);
  placementPreviewObject.setAttribute('transform', `translate(${point.x}, ${point.y})`);
}
