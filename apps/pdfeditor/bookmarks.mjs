// Bookmarks are one tree: [{ id, title, pageId, collapsed, children }]. pageId is the editor's
// page.id, so reordering and rotating pages keep the target. pageId is null only for a heading,
// which is a node without a target that exists to hold children.
// collapsed is how the node was stored in the PDF; folding in the panel does not change it.
import { PDFHexString, PDFName } from "./vendor/pdf-lib.esm.js?v=c1879c6d";

export const MAX_BOOKMARKS = 5000;
export const MAX_BOOKMARK_DEPTH = 32;
export const MAX_BOOKMARK_TITLE_LENGTH = 500;
export const UNTITLED_BOOKMARK = "（タイトルなし）";

// Titles come from the PDF or a work file. They are shown with textContent only; this removes
// what would break a single-line list or the output, and bounds the length by code points.
export function cleanBookmarkTitle(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return Array.from(text).slice(0, MAX_BOOKMARK_TITLE_LENGTH).join("").trim();
}

export function countBookmarks(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + countBookmarks(node.children), 0);
}

export function walkBookmarks(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walkBookmarks(node.children, visit);
  }
}

// Returns the array that holds the node, so callers can reorder or remove it.
export function findBookmark(nodes, id, parent = null) {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.id === id) return { node, siblings: nodes, index, parent };
    const found = findBookmark(node.children, id, node);
    if (found) return found;
  }
  return null;
}

// Moves within the same level only. Returns false at either end.
export function moveBookmark(nodes, id, delta) {
  const found = findBookmark(nodes, id);
  if (!found) return false;
  const target = found.index + delta;
  if (target < 0 || target >= found.siblings.length) return false;
  found.siblings.splice(found.index, 1);
  found.siblings.splice(target, 0, found.node);
  return true;
}

// A heading exists only to hold children, so one left empty goes too. Returns how many went.
function removeEmptyHeadings(nodes) {
  let removed = 0;
  for (let index = nodes.length - 1; index >= 0; index--) {
    removed += removeEmptyHeadings(nodes[index].children);
    if (nodes[index].pageId === null && !nodes[index].children.length) {
      nodes.splice(index, 1);
      removed++;
    }
  }
  return removed;
}

export function removeBookmark(nodes, id) {
  const found = findBookmark(nodes, id);
  if (!found) return 0;
  found.siblings.splice(found.index, 1);
  return 1 + countBookmarks(found.node.children) + removeEmptyHeadings(nodes);
}

/*
 * Keeps only what can still point to one of the pages. A node whose page is gone becomes a
 * heading while it has children left, otherwise it is dropped. Returns new nodes; ids are kept.
 * removed: dropped nodes. headings: nodes that lost their target but remain.
 */
export function pruneBookmarks(nodes, keepPageIds) {
  let removed = 0, headings = 0;
  const walk = list => list.flatMap(node => {
    const children = walk(node.children);
    const kept = node.pageId !== null && keepPageIds.has(node.pageId);
    if (!kept && !children.length) {
      removed++;
      return [];
    }
    if (!kept && node.pageId !== null) headings++;
    return [{ ...node, pageId: kept ? node.pageId : null, children }];
  });
  return { bookmarks: walk(nodes), removed, headings };
}

/*
 * Inserts new root bookmarks, in the given order, before the first root bookmark whose subtree
 * only points after the given pages. Existing bookmarks are never sorted.
 * pageIds: all page ids in their final order.
 */
export function insertBookmarksByPage(nodes, added, pageIds, insertAt, addedCount = 1) {
  if (!added.length) return nodes;
  const end = insertAt + addedCount;
  const order = new Map(pageIds.map((id, index) => [id, index]));
  const earliest = node => Math.min(order.get(node.pageId) ?? Infinity, ...node.children.map(earliest));
  const position = nodes.findIndex(node => {
    const index = earliest(node);
    return index >= end && index !== Infinity;
  });
  const result = [...nodes];
  result.splice(position < 0 ? result.length : position, 0, ...added);
  return result;
}

// indexes: Map(pageId -> index of the page in the file). A heading has page null.
export function bookmarksToProject(nodes, indexes) {
  return nodes.map(node => ({
    title: node.title,
    page: node.pageId === null ? null : indexes.get(node.pageId),
    collapsed: node.collapsed === true,
    children: bookmarksToProject(node.children, indexes),
  }));
}

export function bookmarksFromProject(list, pageIds, createId) {
  return list.map(item => ({
    id: createId(),
    title: item.title,
    pageId: item.page === null ? null : pageIds[item.page],
    collapsed: item.collapsed,
    children: bookmarksFromProject(item.children, pageIds, createId),
  }));
}

// Identity of the tree for "nothing changed": ids are per load, so they are left out.
export function canonicalBookmarks(nodes) {
  const shape = list => list.map(n => [n.title, n.pageId, n.collapsed === true, shape(n.children)]);
  return JSON.stringify(shape(nodes));
}

async function resolvePageIndex(pdfjsDoc, dest, pageCount, namedDests) {
  let target = dest;
  if (typeof target === "string") {
    if (!namedDests.has(target)) namedDests.set(target, await pdfjsDoc.getDestination(target));
    target = namedDests.get(target);
  }
  if (!Array.isArray(target)) return null;
  const page = target[0];
  const index = Number.isInteger(page) ? page
    : page && typeof page === "object" ? await pdfjsDoc.getPageIndex(page) : null;
  return Number.isInteger(index) && index >= 0 && index < pageCount ? index : null;
}

/*
 * Reads the outline of an opened PDF.js document. Only a jump to a page is supported.
 * A node without a page stays as a heading while it has children, otherwise it is skipped.
 * Both are counted so the caller can say what may not be kept: PDF.js does not report every
 * action (JavaScript comes back as nothing at all), so a plain heading cannot be told apart.
 * Returns { bookmarks, skipped, headings, failed }. A failure here must not stop opening the PDF.
 * PDF.js also answers null for some outlines it cannot parse, which looks the same as having none.
 * capacity: how many more bookmarks the document can hold.
 */
export async function readPdfOutline(pdfjsDoc, pageIds, createId, capacity = MAX_BOOKMARKS) {
  let outline;
  try {
    outline = await pdfjsDoc.getOutline();
  } catch (error) {
    console.warn("PDFのしおりを読み込めませんでした。", error);
    return { bookmarks: [], skipped: 0, headings: 0, failed: true };
  }
  const namedDests = new Map();
  let total = 0, skipped = 0, headings = 0;
  const countAll = items => (items || []).reduce((sum, item) => sum + 1 + countAll(item.items), 0);
  const walk = async (items, depth) => {
    const nodes = [];
    for (const item of items || []) {
      if (depth >= MAX_BOOKMARK_DEPTH || total >= capacity) {
        skipped += 1 + countAll(item.items);
        continue;
      }
      total++;
      let pageIndex = null;
      if (item.dest) {
        try {
          pageIndex = await resolvePageIndex(pdfjsDoc, item.dest, pageIds.length, namedDests);
        } catch {
          pageIndex = null;
        }
      }
      const children = await walk(item.items, depth + 1);
      if (pageIndex === null && !children.length) {
        total--;
        skipped++;
        continue;
      }
      if (pageIndex === null) headings++;
      nodes.push({
        id: createId(),
        title: cleanBookmarkTitle(item.title) || UNTITLED_BOOKMARK,
        pageId: pageIndex === null ? null : pageIds[pageIndex],
        collapsed: item.count < 0 && children.length > 0,
        children,
      });
    }
    return nodes;
  };
  try {
    return { bookmarks: await walk(outline, 0), skipped, headings, failed: false };
  } catch (error) {
    console.warn("PDFのしおりを読み込めませんでした。", error);
    return { bookmarks: [], skipped: 0, headings: 0, failed: true };
  }
}

/*
 * Writes the tree as the document outline. pageRefs: Map(pageId -> ref of the page in document).
 * Prune to the output pages first; a node without a known page is written as a heading.
 */
export function writePdfOutline(document, nodes, pageRefs) {
  if (!nodes.length) return;
  const context = document.context;
  const write = (list, parentRef) => {
    const refs = list.map(() => context.nextRef());
    let visible = 0;
    list.forEach((node, index) => {
      const entries = {
        Title: PDFHexString.fromText(node.title),
        Parent: parentRef,
      };
      if (index > 0) entries.Prev = refs[index - 1];
      if (index < list.length - 1) entries.Next = refs[index + 1];
      const pageRef = pageRefs.get(node.pageId);
      if (pageRef) entries.Dest = [pageRef, "Fit"];
      visible++;
      if (node.children.length) {
        const child = write(node.children, refs[index]);
        entries.First = child.first;
        entries.Last = child.last;
        // A negative count marks a closed node; the size is what opening it would show.
        entries.Count = node.collapsed ? -child.visible : child.visible;
        if (!node.collapsed) visible += child.visible;
      }
      context.assign(refs[index], context.obj(entries));
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };
  const root = context.nextRef();
  const { first, last, visible } = write(nodes, root);
  context.assign(root, context.obj({ Type: "Outlines", First: first, Last: last, Count: visible }));
  document.catalog.set(PDFName.of("Outlines"), root);
}
