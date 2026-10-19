// Geometry is stored in displayed page points (top-left origin), independent of zoom.
import { inkBounds } from "./ink.mjs?v=1.8.0";
export const isLine = (a) => a.type === "arrow" || a.type === "line";
export function bounds(a) {
  if (a.type === "ink") return inkBounds(a.points);
  if (isLine(a))
    return {
      x: Math.min(a.x1, a.x2),
      y: Math.min(a.y1, a.y2),
      w: Math.abs(a.x2 - a.x1),
      h: Math.abs(a.y2 - a.y1),
    };
  if (a.type === "highlight") {
    const x = Math.min(...a.rects.map((r) => r.x)),
      y = Math.min(...a.rects.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...a.rects.map((r) => r.x + r.w)) - x,
      h: Math.max(...a.rects.map((r) => r.y + r.h)) - y,
    };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}
export function translate(a, dx, dy) {
  if (a.type === "ink") {
    for (const p of a.points) { p.x += dx; p.y += dy; }
  } else if (isLine(a)) {
    a.x1 += dx;
    a.x2 += dx;
    a.y1 += dy;
    a.y2 += dy;
  } else if (a.type === "highlight")
    a.rects.forEach((r) => {
      r.x += dx;
      r.y += dy;
    });
  else {
    a.x += dx;
    a.y += dy;
  }
  return a;
}
export function rotateAnnotation(a, size, delta) {
  if (a.type === "image") a.rotation = ((a.rotation || 0) + delta + 360) % 360;
  const point = (x, y) => (delta > 0 ? { x: size.height - y, y: x } : { x: y, y: size.width - x });
  if (a.type === "ink") {
    a.points = a.points.map(p => point(p.x, p.y));
  } else if (isLine(a)) {
    const p = point(a.x1, a.y1),
      q = point(a.x2, a.y2);
    Object.assign(a, { x1: p.x, y1: p.y, x2: q.x, y2: q.y });
  } else {
    for (const r of a.type === "highlight" ? a.rects : [a]) {
      const p = point(delta > 0 ? r.x : r.x + r.w, delta > 0 ? r.y + r.h : r.y);
      Object.assign(r, { x: p.x, y: p.y, w: r.h, h: r.w });
    }
  }
}
// Annotations are stored from back to front; keep each group's relative order.
export function reorderAnnotations(annotations, ids, position) {
  if (position !== "front" && position !== "back") return annotations;
  const selected = new Set(ids),
    moving = annotations.filter((a) => selected.has(a.id)),
    rest = annotations.filter((a) => !selected.has(a.id));
  if (!moving.length || !rest.length) return annotations;
  const result = position === "front" ? [...rest, ...moving] : [...moving, ...rest];
  return result.every((a, index) => a === annotations[index]) ? annotations : result;
}

export function movePages(pages, ids, targetId, after = false) {
  const selected = new Set(ids);
  if (selected.has(targetId) || !pages.some((p) => p.id === targetId)) return pages;
  const moving = pages.filter((p) => selected.has(p.id)),
    rest = pages.filter((p) => !selected.has(p.id));
  const index = rest.findIndex((p) => p.id === targetId) + (after ? 1 : 0);
  return [...rest.slice(0, index), ...moving, ...rest.slice(index)];
}
export function stepPages(pages, ids, direction) {
  const result = [...pages],
    selected = new Set(ids);
  if (direction < 0) {
    for (let i = 1; i < result.length; i++)
      if (selected.has(result[i].id) && !selected.has(result[i - 1].id))
        [result[i - 1], result[i]] = [result[i], result[i - 1]];
  } else {
    for (let i = result.length - 2; i >= 0; i--)
      if (selected.has(result[i].id) && !selected.has(result[i + 1].id))
        [result[i + 1], result[i]] = [result[i], result[i + 1]];
  }
  return result;
}
export function rangeIds(pages, anchor, target) {
  const a = pages.findIndex((p) => p.id === anchor),
    b = pages.findIndex((p) => p.id === target);
  return a < 0 || b < 0
    ? [target]
    : pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id);
}
export function nearestCorner(x, y, width, height) {
  return `${y < height / 2 ? "top" : "bottom"}-${x < width / 2 ? "left" : "right"}`;
}

export function drawingBox(start, point, size, constrained = false) {
  if (!constrained) {
    return {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    };
  }

  const dx = point.x - start.x,
    dy = point.y - start.y,
    directionX = dx < 0 ? -1 : 1,
    directionY = dy < 0 ? -1 : 1,
    availableX = directionX < 0 ? start.x : size.width - start.x,
    availableY = directionY < 0 ? start.y : size.height - start.y,
    side = Math.max(
      0,
      Math.min(
        Math.max(Math.abs(dx), Math.abs(dy)),
        availableX,
        availableY,
      ),
    ),
    endX = start.x + directionX * side,
    endY = start.y + directionY * side;

  return {
    x: Math.min(start.x, endX),
    y: Math.min(start.y, endY),
    w: side,
    h: side,
  };
}

export function constrainedLinePoint(anchor, point, constrained = false) {
  if (!constrained) return { x: point.x, y: point.y };

  const dx = point.x - anchor.x,
    dy = point.y - anchor.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: point.x, y: anchor.y };
  }

  return { x: anchor.x, y: point.y };
}

export function angleLockedLinePoint(anchor, originalPoint, point, size = null) {
  const dx = originalPoint.x - anchor.x,
    dy = originalPoint.y - anchor.y,
    lengthSquared = dx * dx + dy * dy;

  if (!lengthSquared) return { x: point.x, y: point.y };

  const projectedScale =
    ((point.x - anchor.x) * dx + (point.y - anchor.y) * dy) / lengthSquared;
  let maxScale = Infinity;

  if (size) {
    if (dx > 0) maxScale = Math.min(maxScale, (size.width - anchor.x) / dx);
    else if (dx < 0) maxScale = Math.min(maxScale, anchor.x / -dx);
    if (dy > 0) maxScale = Math.min(maxScale, (size.height - anchor.y) / dy);
    else if (dy < 0) maxScale = Math.min(maxScale, anchor.y / -dy);
  }

  const scale = Math.max(0, Math.min(maxScale, projectedScale));
  return {
    x: anchor.x + dx * scale,
    y: anchor.y + dy * scale,
  };
}

export function resizeBox(original, dx, dy, size, constrained = false, minWidth = 8, minHeight = 8) {
  const maxWidth = Math.max(0, size.width - original.x),
    maxHeight = Math.max(0, size.height - original.y);

  if (!constrained || original.w <= 0 || original.h <= 0) {
    return {
      w: Math.min(maxWidth, Math.max(minWidth, original.w + dx)),
      h: Math.min(maxHeight, Math.max(minHeight, original.h + dy)),
    };
  }

  const scaleX = (original.w + dx) / original.w,
    scaleY = (original.h + dy) / original.h,
    desiredScale =
      Math.abs(scaleX - 1) >= Math.abs(scaleY - 1)
        ? scaleX
        : scaleY,
    minScale = Math.max(minWidth / original.w, minHeight / original.h),
    maxScale = Math.min(maxWidth / original.w, maxHeight / original.h),
    // Thin shapes may not fit their minimum size while retaining the ratio.
    // Page bounds take precedence in that case.
    scale = Math.min(maxScale, Math.max(minScale, desiredScale));

  return {
    w: original.w * scale,
    h: original.h * scale,
  };
}


// Small/medium share a raster; large thumbnails get a sharper preview on demand.
export function thumbnailRasterSize(size) {
  return size === "large" ? { width: 210, height: 296 } : { width: 155, height: 218 };
}

// Count actual grid positions, including gaps and padding, for keyboard navigation.
export function thumbnailColumns(items) {
  if (!items.length) return 1;
  const nextRow = items.findIndex((item) => item.offsetTop > items[0].offsetTop + 1);
  return nextRow > 0 ? nextRow : items.length;
}

function pageRenderRotation(page) {
  if (!page) return null;
  return (
    ((Number(page.baseRotation) || 0) + (Number(page.rotationExtra) || 0)) %
      360 +
    360
  ) % 360;
}

export function samePageRaster(before, after) {
  return Boolean(
    before &&
      after &&
      before.id === after.id &&
      before.sourceId === after.sourceId &&
      before.sourceIndex === after.sourceIndex &&
      pageRenderRotation(before) === pageRenderRotation(after),
  );
}

export function samePageLayout(beforePages, afterPages) {
  return (
    beforePages.length === afterPages.length &&
    beforePages.every((page, index) =>
      samePageRaster(page, afterPages[index]),
    )
  );
}

export function selectionRects(rects, host, scale, size) {
  const safeScale = Math.max(Number(scale) || 0, 0.0001);
  const normalized = [];

  for (const rect of rects) {
    const x = Math.max(0, (rect.left - host.left) / safeScale),
      y = Math.max(0, (rect.top - host.top) / safeScale),
      right = Math.min(
        size.width,
        (rect.right - host.left) / safeScale,
      ),
      bottom = Math.min(
        size.height,
        (rect.bottom - host.top) / safeScale,
      ),
      w = right - x,
      h = bottom - y;

    if (w < 0.5 || h < 0.5) continue;

    const candidate = { x, y, w, h };
    const duplicate = normalized.some(
      (item) =>
        Math.abs(item.x - candidate.x) < 0.5 &&
        Math.abs(item.y - candidate.y) < 0.5 &&
        Math.abs(item.w - candidate.w) < 0.5 &&
        Math.abs(item.h - candidate.h) < 0.5,
    );

    if (!duplicate) normalized.push(candidate);
  }

  normalized.sort(
    (a, b) =>
      a.y + a.h / 2 - (b.y + b.h / 2) ||
      a.x - b.x,
  );

  const rows = [];
  for (const rect of normalized) {
    const center = rect.y + rect.h / 2;
    let best = null;
    let bestScore = -Infinity;

    for (const row of rows) {
      const overlap = Math.max(
        0,
        Math.min(rect.y + rect.h, row.bottom) -
          Math.max(rect.y, row.top),
      );
      const overlapRatio =
        overlap /
        Math.max(0.0001, Math.min(rect.h, row.height));
      const centerDistance = Math.abs(center - row.center);
      const centerTolerance = Math.max(
        1,
        Math.min(rect.h, row.height) * 0.35,
      );

      if (
        overlapRatio >= 0.5 ||
        centerDistance <= centerTolerance
      ) {
        const score =
          overlapRatio - centerDistance * 0.0001;
        if (score > bestScore) {
          best = row;
          bestScore = score;
        }
      }
    }

    if (!best) {
      rows.push({
        rects: [rect],
        top: rect.y,
        bottom: rect.y + rect.h,
        height: rect.h,
        center,
      });
      continue;
    }

    best.rects.push(rect);
    best.top = Math.min(best.top, rect.y);
    best.bottom = Math.max(best.bottom, rect.y + rect.h);
    best.height = best.bottom - best.top;
    best.center =
      best.rects.reduce(
        (sum, item) => sum + item.y + item.h / 2,
        0,
      ) / best.rects.length;
  }

  rows.sort((a, b) => a.center - b.center);

  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1],
      current = rows[index],
      overlap = previous.bottom - current.top;

    if (
      overlap <= 0 ||
      overlap >
        Math.min(previous.height, current.height) * 0.45
    ) {
      continue;
    }

    const boundary =
      (previous.bottom + current.top) / 2;
    previous.bottom = boundary;
    previous.height = Math.max(
      0.5,
      previous.bottom - previous.top,
    );
    current.top = boundary;
    current.height = Math.max(
      0.5,
      current.bottom - current.top,
    );
  }

  const result = [];
  for (const row of rows) {
    const y = Math.max(0, row.top),
      bottom = Math.min(size.height, row.bottom),
      h = bottom - y;

    if (h < 0.5) continue;

    const parts = row.rects
      .map((rect) => ({ x: rect.x, y, w: rect.w, h }))
      .sort((a, b) => a.x - b.x);

    let current = parts[0];
    for (const rect of parts.slice(1)) {
      const right = current.x + current.w;

      if (rect.x <= right + 0.75) {
        current.w =
          Math.max(right, rect.x + rect.w) -
          current.x;
      } else {
        result.push(current);
        current = rect;
      }
    }
    result.push(current);
  }

  return result;
}
