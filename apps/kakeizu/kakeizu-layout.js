"use strict";

(function exposeKakeizuLayout(root, factory) {
  const layout = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = layout;
  } else {
    root.KakeizuLayout = layout;
  }
})(globalThis, function createKakeizuLayout() {
  const NODE_W = 190;
  const NODE_H = 132;
  const HORIZONTAL_GAP = 40;
  const VERTICAL_GAP = 80;
  const FAMILY_GROUP_GAP = 80;
  const UNCONNECTED_COLUMNS = 3;
  const START_X = 120;
  const START_Y = 120;

  function compareIds(left, right) {
    const leftText = String(left);
    const rightText = String(right);

    if (leftText < rightText) return -1;
    if (leftText > rightText) return 1;
    return 0;
  }

  function compareIdLists(left, right) {
    const length = Math.min(left.length, right.length);

    for (let index = 0; index < length; index++) {
      const difference = compareIds(left[index], right[index]);
      if (difference !== 0) return difference;
    }

    return left.length - right.length;
  }

  function uniqueExistingIds(ids, peopleById) {
    const seen = new Set();
    const uniqueIds = [];

    (Array.isArray(ids) ? ids : []).forEach(id => {
      if (!peopleById.has(id) || seen.has(id)) return;
      seen.add(id);
      uniqueIds.push(id);
    });

    return uniqueIds.sort(compareIds);
  }

  function compareFamilies(left, right) {
    return (
      compareIdLists(left.parents, right.parents) ||
      compareIdLists(left.children, right.children)
    );
  }

  function calculateGenerations(connectedIds, families) {
    const generations = new Map(
      [...connectedIds].map(id => [id, 0])
    );
    let changed = true;
    let iteration = 0;

    while (changed && iteration < 100) {
      changed = false;
      iteration++;

      families.forEach(family => {
        const parentGenerations = family.parents
          .map(id => generations.get(id))
          .filter(Number.isFinite);
        const parentGeneration = parentGenerations.length
          ? Math.max(...parentGenerations)
          : 0;

        family.parents.forEach(id => {
          const current = generations.get(id) ?? 0;
          if (current === parentGeneration) return;
          generations.set(id, parentGeneration);
          changed = true;
        });

        family.children.forEach(id => {
          const current = generations.get(id) ?? 0;
          const next = Math.max(current, parentGeneration + 1);
          if (next === current) return;
          generations.set(id, next);
          changed = true;
        });
      });
    }

    return generations;
  }

  function orderGenerationGroups(
    generationPeople,
    generations,
    families
  ) {
    const generationIds = new Set(
      generationPeople.map(person => person.id)
    );
    const candidates = [];

    families.forEach(family => {
      [family.parents, family.children].forEach((members, priority) => {
        const ids = members.filter(id =>
          generationIds.has(id) && generations.has(id)
        );

        if (ids.length >= 2) {
          candidates.push({
            ids,
            priority
          });
        }
      });
    });

    candidates.sort((left, right) =>
      left.priority - right.priority ||
      compareIdLists(left.ids, right.ids)
    );

    const usedIds = new Set();
    const groups = [];
    let previousCandidate = null;

    candidates.forEach(candidate => {
      if (
        previousCandidate &&
        compareIdLists(
          previousCandidate.ids,
          candidate.ids
        ) === 0
      ) {
        return;
      }

      previousCandidate = candidate;
      const ids = candidate.ids.filter(id =>
        !usedIds.has(id)
      );

      if (ids.length < 2) return;
      groups.push({
        ids,
        isFamilyGroup: true
      });
      ids.forEach(id => usedIds.add(id));
    });

    const ungroupedIds = generationPeople
      .filter(person => !usedIds.has(person.id))
      .map(person => person.id)
      .sort(compareIds);

    if (ungroupedIds.length) {
      groups.push({
        ids: ungroupedIds,
        isFamilyGroup: false
      });
    }

    return groups.sort((left, right) =>
      compareIdLists(left.ids, right.ids)
    );
  }


  function calculateAutoLayout(people, families, options = {}) {
    const startX = options.startX ?? START_X;
    const startY = options.startY ?? START_Y;
    const peopleById = new Map(
      people.map(person => [person.id, person])
    );
    const normalizedFamilies = families
      .map(family => ({
        parents: uniqueExistingIds(family.parents, peopleById),
        children: uniqueExistingIds(family.children, peopleById)
      }))
      .sort(compareFamilies);
    const connectedIds = new Set();

    normalizedFamilies.forEach(family => {
      family.parents.forEach(id => connectedIds.add(id));
      family.children.forEach(id => connectedIds.add(id));
    });

    const connectedPeople = people.filter(person =>
      connectedIds.has(person.id)
    );
    const positions = new Map();

    if (connectedPeople.length) {
      const generations = calculateGenerations(
        connectedIds,
        normalizedFamilies
      );
      const maxGeneration = Math.max(...generations.values());

      for (let generation = 0; generation <= maxGeneration; generation++) {
        const generationPeople = connectedPeople.filter(person =>
          generations.get(person.id) === generation
        );
        const groups = orderGenerationGroups(
          generationPeople,
          generations,
          normalizedFamilies
        );
        const generationY =
          startY + generation * (NODE_H + VERTICAL_GAP);
        let x = startX;
        let hasPlacedGroup = false;
        let previousWasFamilyGroup = false;

        groups.forEach(group => {
          if (
            hasPlacedGroup &&
            (previousWasFamilyGroup || group.isFamilyGroup)
          ) {
            x += FAMILY_GROUP_GAP;
          }

          group.ids.forEach((id, index) => {
            positions.set(id, {
              x: x + index * (NODE_W + HORIZONTAL_GAP),
              y: generationY
            });
          });

          x +=
            group.ids.length * NODE_W +
            Math.max(0, group.ids.length - 1) * HORIZONTAL_GAP;
          hasPlacedGroup = true;
          previousWasFamilyGroup = group.isFamilyGroup;
        });
      }

      normalizedFamilies.forEach(family => {
        const parents = family.parents
          .filter(id => connectedIds.has(id))
          .map(id => ({
            id,
            ...positions.get(id)
          }))
          .sort((left, right) => left.x - right.x);

        if (parents.length < 2) return;
        const familyY = Math.min(...parents.map(parent => parent.y));
        parents.forEach(parent => {
          positions.get(parent.id).y = familyY;
        });
      });
    }

    let connectedMinX = Infinity;
    let connectedMaxY = -Infinity;

    connectedPeople.forEach(person => {
      const position = positions.get(person.id);
      connectedMinX = Math.min(connectedMinX, position.x);
      connectedMaxY = Math.max(
        connectedMaxY,
        position.y + NODE_H
      );
    });

    const unconnectedStartX = connectedPeople.length
      ? connectedMinX
      : startX;
    const unconnectedStartY = connectedPeople.length
      ? connectedMaxY + VERTICAL_GAP
      : startY;
    people
      .filter(person => !connectedIds.has(person.id))
      .map(person => person.id)
      .sort(compareIds)
      .forEach((id, index) => {
        const column = index % UNCONNECTED_COLUMNS;
        const row = Math.floor(index / UNCONNECTED_COLUMNS);
        positions.set(id, {
          x: unconnectedStartX + column * (NODE_W + HORIZONTAL_GAP),
          y: unconnectedStartY + row * (NODE_H + VERTICAL_GAP)
        });
      });

    return positions;

  }

  return {
    NODE_W,
    NODE_H,
    calculateAutoLayout
  };
});
