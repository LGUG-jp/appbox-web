// Ink coordinates use displayed PDF page points (top-left origin), never pixels.
export const MAX_STROKE_POINTS = 8192;
export const MAX_DOCUMENT_INK_POINTS = 200_000;

export function inkBounds(points) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x); top = Math.min(top, p.y);
    right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
  }
  return points.length ? { x: left, y: top, w: right - left, h: bottom - top }
    : { x: 0, y: 0, w: 0, h: 0 };
}

export function appendInkPoint(points, point, limit = MAX_STROKE_POINTS) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || points.length >= limit) return false;
  const last = points.at(-1);
  if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.25) return false;
  points.push({ x: point.x, y: point.y });
  return true;
}

// A short virtual leash suppresses small movements with a bounded trailing distance.
// Distances are PDF points, so the correction does not change with view zoom.
export function stabilizeInkPoint(previous, point, level = "none") {
  const radius = level === "weak" ? 1.5 : level === "medium" ? 3 : level === "strong" ? 6 : 0;
  if (!previous || !radius) return { x: point.x, y: point.y };
  const dx = point.x - previous.x, dy = point.y - previous.y, distance = Math.hypot(dx, dy);
  if (distance <= radius) return { x: previous.x, y: previous.y };
  const follow = (distance - radius) / distance;
  return { x: previous.x + dx * follow, y: previous.y + dy * follow };
}

export function inkPath(points) {
  return points.map((p, i) => `${i ? "L" : "M"} ${Number(p.x.toFixed(3))} ${Number(p.y.toFixed(3))}`).join(" ");
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function segmentsDistance(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC < 0 && abD > 0) || (abC > 0 && abD < 0)) &&
      ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0))) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

export function inkIntersectsSegment(stroke, from, to, radius, box = inkBounds(stroke.points)) {
  const reach = radius + stroke.strokeWidth / 2, b = box;
  if (Math.max(from.x, to.x) + reach < b.x || Math.min(from.x, to.x) - reach > b.x + b.w ||
      Math.max(from.y, to.y) + reach < b.y || Math.min(from.y, to.y) - reach > b.y + b.h) return false;
  if (stroke.points.length === 1) return pointSegmentDistance(stroke.points[0], from, to) <= reach;
  for (let i = 1; i < stroke.points.length; i++)
    if (segmentsDistance(from, to, stroke.points[i - 1], stroke.points[i]) <= reach) return true;
  return false;
}

export function documentInkPointCount(pages) {
  return pages.reduce((total, page) => total + page.annotations.reduce((n, a) =>
    n + (a.type === "ink" ? a.points.length : 0), 0), 0);
}

export function acceptsInkPointer(event, touchEnabled) {
  return event.button === 0 && event.isPrimary !== false &&
    (event.pointerType !== "touch" || touchEnabled);
}
