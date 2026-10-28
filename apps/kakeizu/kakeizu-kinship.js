"use strict";

(function exposeKakeizuKinship(root, factory) {
  const kinship = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = kinship;
  } else {
    root.KakeizuKinship = kinship;
  }
})(globalThis, function createKakeizuKinship() {
  const validId = id => typeof id === "string" && id.trim().length > 0;
  const pairKey = (a, b) => JSON.stringify([a, b]);

  function diagnostic(diagnostics, code, personIds, refs, severity = "conflict") {
    diagnostics.push({ code, severity, personIds: [...new Set(personIds)], refs });
  }

  // Only legacy family structure is evidence. In particular, cached people.parents
  // and people.spouses, names, dates and existing relation labels are not read.
  function interpretLegacy(people, families) {
    const graph = { persons: [], parentChildEdges: [], partnerHints: [], diagnostics: [] };
    const ids = new Set();
    for (const person of Array.isArray(people) ? people : []) {
      if (!person || !validId(person.id)) {
        diagnostic(graph.diagnostics, "INVALID_PERSON_ID", [], []);
      } else if (ids.has(person.id)) {
        diagnostic(graph.diagnostics, "DUPLICATE_PERSON_ID", [person.id], []);
      } else {
        ids.add(person.id);
        graph.persons.push({ id: person.id, gender: person.gender || "" });
      }
    }
    const edges = new Set();
    const pairs = new Set();
    (Array.isArray(families) ? families : []).forEach((family, index) => {
      // Include the array position even when a legacy family ID is duplicated.
      const ref = `legacy-family:${index}:${family && validId(family.id) ? family.id : ""}`;
      const known = [];
      const readMembers = field => {
        if (!family || !Array.isArray(family[field])) return [];
        return family[field].filter(id => ids.has(id));
      };
      known.push(...readMembers("parents"), ...readMembers("children"));
      let malformed = false;
      const members = field => {
        if (!family || !Array.isArray(family[field])) {
          malformed = true;
          return [];
        }
        const seen = new Set();
        return family[field].filter(id => {
          if (!validId(id) || !ids.has(id)) {
            malformed = true;
            return false;
          }
          if (seen.has(id)) {
            diagnostic(graph.diagnostics, "DUPLICATE_FAMILY_MEMBER", [id], [ref], "warning");
            return false;
          }
          seen.add(id);
          return true;
        });
      };
      const parents = members("parents");
      const children = members("children");
      if (malformed) diagnostic(graph.diagnostics, "INVALID_FAMILY_REFERENCE", known, [ref]);
      for (const parentId of parents) {
        for (const childId of children) {
          if (parentId === childId) {
            diagnostic(graph.diagnostics, "SELF_PARENT", [parentId], [ref]);
            continue;
          }
          const key = pairKey(parentId, childId);
          if (edges.has(key)) {
            diagnostic(graph.diagnostics, "DUPLICATE_PARENT_CHILD_EDGE", [parentId, childId], [ref], "warning");
            continue;
          }
          edges.add(key);
          graph.parentChildEdges.push({ ref, parentId, childId, parentKind: "unspecified", source: "legacy-family" });
        }
      }
      // A pair is a hint, not a marriage assertion, including childless families.
      if (parents.length === 2) {
        const [personAId, personBId] = parents;
        const key = pairKey(...parents.slice().sort());
        if (pairs.has(key)) {
          diagnostic(graph.diagnostics, "DUPLICATE_PARTNER_HINT", parents, [ref], "warning");
        } else {
          pairs.add(key);
          graph.partnerHints.push({ ref, personAId, personBId, status: "unknown", source: "legacy-family-pair" });
        }
      }
    });
    const structure = buildStructure(graph);
    for (const personIds of structure.cyclicComponents) {
      diagnostic(graph.diagnostics, "PARENT_CHILD_CYCLE", personIds, []);
    }
    return graph;
  }

  function buildStructure(graph) {
    const persons = new Map();
    for (const person of graph.persons || []) {
      if (person && validId(person.id) && !persons.has(person.id)) persons.set(person.id, person);
    }
    const up = new Map();
    const down = new Map();
    const neighbors = new Map();
    for (const id of persons.keys()) {
      up.set(id, []);
      down.set(id, []);
      neighbors.set(id, []);
    }
    const edgeKeys = new Set();
    for (const edge of graph.parentChildEdges || []) {
      if (!persons.has(edge.parentId) || !persons.has(edge.childId)) continue;
      const key = pairKey(edge.parentId, edge.childId);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      up.get(edge.childId).push({ id: edge.parentId, ref: edge.ref });
      down.get(edge.parentId).push({ id: edge.childId, ref: edge.ref });
      neighbors.get(edge.parentId).push(edge.childId);
      neighbors.get(edge.childId).push(edge.parentId);
    }
    const component = new Map();
    const components = [];
    for (const id of persons.keys()) {
      if (component.has(id)) continue;
      const queue = [id];
      const index = components.length;
      component.set(id, index);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        for (const next of neighbors.get(queue[cursor])) {
          if (component.has(next)) continue;
          component.set(next, index);
          queue.push(next);
        }
      }
      components.push(queue);
    }
    // Kahn's algorithm is iterative: very deep or dense data never recurse.
    const indegree = new Map([...up].map(([id, parents]) => [id, parents.length]));
    const queue = [...persons.keys()].filter(id => indegree.get(id) === 0);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const edge of down.get(queue[cursor])) {
        const remaining = indegree.get(edge.id) - 1;
        indegree.set(edge.id, remaining);
        if (remaining === 0) queue.push(edge.id);
      }
    }
    const cyclic = new Set();
    for (const [id, degree] of indegree) if (degree > 0) cyclic.add(component.get(id));
    return { persons, up, down, neighbors, component, cyclicComponents: [...cyclic].map(index => components[index]) };
  }

  function label(kind, gender) {
    const labels = {
      self: ["本人", "本人", "本人"],
      parent: ["親", "父", "母"],
      child: ["子", "息子", "娘"],
      grandparent: ["祖父母", "祖父", "祖母"],
      grandchild: ["孫", "孫", "孫"],
      sibling: ["きょうだい", "きょうだい", "きょうだい"],
      auntUncle: ["親のきょうだい", "おじ", "おば"],
      nieceNephew: ["きょうだいの子", "甥", "姪"],
      partner: ["配偶者（要確認）", "配偶者（要確認）", "配偶者（要確認）"]
    };
    return labels[kind][gender === "男性" ? 1 : gender === "女性" ? 2 : 0];
  }

  function infer(graph, baseId) {
    const { persons, up, down, neighbors, component, cyclicComponents } = buildStructure(graph);
    const componentReasons = new Map();
    const markConflict = (id, code) => {
      if (!component.has(id)) return;
      const index = component.get(id);
      if (!componentReasons.has(index)) componentReasons.set(index, new Set());
      componentReasons.get(index).add(code);
    };
    for (const entry of graph.diagnostics || []) {
      if (entry.severity !== "conflict") continue;
      for (const id of entry.personIds || []) markConflict(id, entry.code);
    }
    for (const ids of cyclicComponents) markConflict(ids[0], "PARENT_CHILD_CYCLE");
    const bad = id => componentReasons.has(component.get(id));
    const candidates = new Map([...persons.keys()].map(id => [id, new Map()]));
    const add = (id, kind, evidence) => {
      const byKind = candidates.get(id);
      if (!byKind.has(kind)) byKind.set(kind, { kind, label: label(kind, persons.get(id).gender), evidence: [] });
      const examples = byKind.get(kind).evidence;
      if (examples.length < 3) examples.push(evidence);
    };
    if (persons.has(baseId)) {
      add(baseId, "self", { personIds: [baseId], refs: [] });
      const patterns = [
        ["parent", "U"], ["child", "D"], ["grandparent", "UU"],
        ["grandchild", "DD"], ["sibling", "UD"],
        ["auntUncle", "UUD"], ["nieceNephew", "UDD"]
      ];
      if (!bad(baseId)) for (const [kind, pattern] of patterns) {
        let frontier = new Map([[baseId, [{ personIds: [baseId], refs: [] }]]]);
        for (let step = 0; step < pattern.length; step++) {
          const next = new Map();
          const adjacency = pattern[step] === "U" ? up : down;
          for (const [id, witnesses] of frontier) {
            for (const edge of adjacency.get(id)) {
              if (bad(edge.id)) continue;
              for (const witness of witnesses) {
                if (witness.personIds.includes(edge.id)) continue;
                if (!next.has(edge.id)) next.set(edge.id, []);
                const examples = next.get(edge.id);
                // At depth two an endpoint has only one interior vertex.
                // Four distinct interiors retain three valid witnesses after
                // excluding the final vertex. No unrestricted path enumeration.
                if (examples.length >= 4) break;
                examples.push({ personIds: [...witness.personIds, edge.id], refs: [...witness.refs, edge.ref] });
              }
            }
          }
          frontier = next;
        }
        for (const [id, examples] of frontier) for (const evidence of examples) add(id, kind, evidence);
      }
      for (const hint of graph.partnerHints || []) {
        const a = hint.personAId;
        const b = hint.personBId;
        if (!persons.has(a) || !persons.has(b) || a === b) continue;
        neighbors.get(a).push(b);
        neighbors.get(b).push(a);
        if (a === baseId && !bad(a) && !bad(b)) add(b, "partner", { personIds: [a, b], refs: [hint.ref] });
        if (b === baseId && !bad(a) && !bad(b)) add(a, "partner", { personIds: [b, a], refs: [hint.ref] });
      }
    }
    const connected = new Set();
    if (persons.has(baseId)) {
      const queue = [baseId];
      connected.add(baseId);
      for (let cursor = 0; cursor < queue.length; cursor++) for (const id of neighbors.get(queue[cursor])) {
        if (!connected.has(id)) { connected.add(id); queue.push(id); }
      }
    }
    return [...persons.keys()].map(personId => {
      const result = (status, values, reason, reasonCodes) => ({ personId, status, candidates: values, reason, reasonCodes });
      if (!persons.has(baseId)) return result("unavailable", [], "基準人物が存在しません。", ["INVALID_BASE"]);
      if (bad(personId)) {
        const codes = [...componentReasons.get(component.get(personId))].sort();
        const descriptions = {
          INVALID_PERSON_ID: "人物IDが不正です。",
          DUPLICATE_PERSON_ID: "同じ人物IDが複数登録されています。",
          INVALID_FAMILY_REFERENCE: "家族関係に不正な人物参照があります。",
          SELF_PARENT: "本人が自身の親として登録されています。",
          PARENT_CHILD_CYCLE: "親子関係が循環しています。"
        };
        const details = [...new Set(codes.map(code => descriptions[code] || "親子関係に矛盾があります。"))].join("");
        return result("conflict", [], `${details}この親子成分では候補を出せません。`, ["INVALID_COMPONENT", ...codes]);
      }
      const values = [...candidates.get(personId).values()];
      if (values.length > 1) return result("multiple", values, "異なる種類の続柄が見つかりました。候補を確認してください。", ["MULTIPLE_KINDS"]);
      if (values.length === 1) {
        if (values[0].kind === "partner") return result("review", values, "同じfamilyの親ペアです。婚姻関係と表示名を確認してください。", ["PARTNER_HINT"]);
        return result("ready", values, personId === baseId ? "基準人物本人です。" : "登録された親子関係から推定しました。", [personId === baseId ? "SELF" : "PARENT_CHILD_PATH"]);
      }
      return connected.has(personId)
        ? result("unavailable", [], "つながりはありますが、対応する続柄の範囲外です。", ["OUT_OF_SCOPE"])
        : result("unavailable", [], "基準人物とのつながりが登録されていません。", ["UNCONNECTED"]);
    });
  }

  return { interpretLegacy, infer };
});
