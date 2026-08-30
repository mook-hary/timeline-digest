import { buildClusterId, buildClusters } from "./news-clusters.js";

function createUnionFind(ids) {
  const parent = new Map();
  for (const id of ids) parent.set(id, id);

  function find(id) {
    let current = id;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }

  function members(root, allIds) {
    return allIds.filter((id) => find(id) === root);
  }

  return { find, union, members };
}

function pairKey(left, right) {
  return left < right ? `${left}\u001f${right}` : `${right}\u001f${left}`;
}

export function buildSemanticClusters({
  items,
  deterministicRelationships,
  clusterConfig,
  judgments,
}) {
  const detClusters = buildClusters(
    items,
    deterministicRelationships,
    clusterConfig
  );
  const allIds = items.map((item) => item.id);
  const { find, union, members } = createUnionFind(allIds);

  for (const cluster of detClusters) {
    const first = cluster.itemIds[0];
    for (const id of cluster.itemIds.slice(1)) {
      union(first, id);
    }
  }

  const forbidden = new Set();
  for (const judgment of judgments) {
    if (judgment.status === "ok" && judgment.relationship === "different-event") {
      forbidden.add(pairKey(judgment.itemA, judgment.itemB));
    }
  }

  const conflicts = [];
  const sameEvent = judgments
    .filter(
      (judgment) =>
        judgment.status === "ok" && judgment.relationship === "same-event"
    )
    .sort((a, b) => {
      if (a.itemA < b.itemA) return -1;
      if (a.itemA > b.itemA) return 1;
      if (a.itemB < b.itemB) return -1;
      if (a.itemB > b.itemB) return 1;
      return 0;
    });

  for (const judgment of sameEvent) {
    const rootA = find(judgment.itemA);
    const rootB = find(judgment.itemB);
    if (rootA === rootB) continue;

    const merged = [
      ...members(rootA, allIds),
      ...members(rootB, allIds),
    ].sort();
    let blocked = null;
    for (let i = 0; i < merged.length && !blocked; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        const key = pairKey(merged[i], merged[j]);
        if (forbidden.has(key)) {
          blocked = { itemA: merged[i], itemB: merged[j] };
          break;
        }
      }
    }

    if (blocked) {
      conflicts.push({
        type: "same-event-different-event",
        attempted: {
          itemA: judgment.itemA,
          itemB: judgment.itemB,
        },
        conflicting: blocked,
      });
      continue;
    }

    union(judgment.itemA, judgment.itemB);
  }

  const groups = new Map();
  for (const id of allIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  const clusters = [];
  for (const itemIds of groups.values()) {
    const sortedIds = [...itemIds].sort();
    const idSet = new Set(sortedIds);
    const relationships = [];

    for (const relationship of deterministicRelationships) {
      if (idSet.has(relationship.itemA) && idSet.has(relationship.itemB)) {
        relationships.push({ ...relationship, origin: "deterministic" });
      }
    }

    for (const judgment of judgments) {
      if (
        judgment.status === "ok" &&
        judgment.relationship === "same-event" &&
        idSet.has(judgment.itemA) &&
        idSet.has(judgment.itemB)
      ) {
        relationships.push({
          itemA: judgment.itemA,
          itemB: judgment.itemB,
          type: "same-event",
          confidence: judgment.confidence,
          signals: ["semantic-judge"],
          origin: "semantic",
        });
      }
    }

    relationships.sort((a, b) => {
      if (a.itemA < b.itemA) return -1;
      if (a.itemA > b.itemA) return 1;
      if (a.itemB < b.itemB) return -1;
      if (a.itemB > b.itemB) return 1;
      if (a.type < b.type) return -1;
      if (a.type > b.type) return 1;
      return 0;
    });

    clusters.push({
      id: buildClusterId(sortedIds),
      itemIds: sortedIds,
      relationships,
    });
  }

  clusters.sort((a, b) => {
    if (b.itemIds.length !== a.itemIds.length) {
      return b.itemIds.length - a.itemIds.length;
    }
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const seenConflict = new Set(
    conflicts.map((conflict) =>
      pairKey(conflict.conflicting.itemA, conflict.conflicting.itemB)
    )
  );
  for (const cluster of clusters) {
    if (cluster.itemIds.length < 2) continue;
    const idSet = new Set(cluster.itemIds);
    for (const judgment of judgments) {
      if (
        judgment.status !== "ok" ||
        judgment.relationship !== "different-event"
      ) {
        continue;
      }
      if (!idSet.has(judgment.itemA) || !idSet.has(judgment.itemB)) continue;
      const key = pairKey(judgment.itemA, judgment.itemB);
      if (seenConflict.has(key)) continue;
      seenConflict.add(key);
      conflicts.push({
        type: "same-event-different-event",
        attempted: null,
        conflicting: { itemA: judgment.itemA, itemB: judgment.itemB },
      });
    }
  }

  return { clusters, conflicts };
}
