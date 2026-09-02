function comparePublishedDesc(left, right) {
  const leftTime = Date.parse(left.cluster.representative?.publishedAt || "");
  const rightTime = Date.parse(right.cluster.representative?.publishedAt || "");
  const leftOk = Number.isFinite(leftTime);
  const rightOk = Number.isFinite(rightTime);
  if (leftOk && rightOk && leftTime !== rightTime) return rightTime - leftTime;
  if (leftOk && !rightOk) return -1;
  if (!leftOk && rightOk) return 1;
  if (left.cluster.clusterId < right.cluster.clusterId) return -1;
  if (left.cluster.clusterId > right.cluster.clusterId) return 1;
  return 0;
}

function compareMajor(left, right) {
  const leftRank = left.majorRank ?? -1;
  const rightRank = right.majorRank ?? -1;
  if (rightRank !== leftRank) return rightRank - leftRank;
  const leftIv = left.cluster.scores?.informationValue ?? -1;
  const rightIv = right.cluster.scores?.informationValue ?? -1;
  if (rightIv !== leftIv) return rightIv - leftIv;
  return comparePublishedDesc(left, right);
}

function comparePersonal(left, right) {
  const leftRank = left.personalRank ?? -1;
  const rightRank = right.personalRank ?? -1;
  if (rightRank !== leftRank) return rightRank - leftRank;
  return comparePublishedDesc(left, right);
}

function compareGeneral(left, right) {
  const leftBase = left.cluster.baseScore ?? -1;
  const rightBase = right.cluster.baseScore ?? -1;
  if (rightBase !== leftBase) return rightBase - leftBase;
  const leftImp = left.cluster.scores?.importance ?? -1;
  const rightImp = right.cluster.scores?.importance ?? -1;
  if (rightImp !== leftImp) return rightImp - leftImp;
  return comparePublishedDesc(left, right);
}

function topicCount(selected, topicGroup) {
  return selected.filter((record) => record.topicGroup === topicGroup).length;
}

function topicAllows(record, selected, lane, config, majorTopIds) {
  const count = topicCount(selected, record.topicGroup);
  if (count < config.topicFreeMax) return true;
  if (count < config.topicSoftMax) {
    return lane === "major" || lane === "personal";
  }
  return lane === "major" && majorTopIds.has(record.cluster.clusterId);
}

function markRejected(record, reason, detail) {
  if (record.decision) return;
  record.decision = "rejected";
  record.rejectionReason = reason;
  record.rejectionDetail = detail || null;
  record.selectionReason = null;
  record.selectionReasons = [];
}

function markSelected(record, reason, lane) {
  record.decision = "selected";
  record.selectionReason = reason;
  record.selectionReasons = [reason];
  record.lane = lane;
  record.rejectionReason = null;
  record.rejectionDetail = null;
}

function noteSkip(record, reason, detail) {
  if (record.skipReason) return;
  record.skipReason = { reason, detail };
}

export function packSelection(records, config) {
  const selected = [];
  const majorCandidates = records
    .filter((record) => record.eligible && record.editorialRole === "main-event" && record.passesMajor)
    .sort(compareMajor);
  const majorTopIds = new Set(
    majorCandidates.slice(0, config.majorTopProtect).map((record) => record.cluster.clusterId)
  );

  for (const record of records) {
    if (!record.eligible) {
      markRejected(record, record.ineligibilityReason, null);
    } else if (record.editorialRole === "related") {
      const main = records.find(
        (entry) =>
          entry.relatedGroupId === record.relatedGroupId && entry.editorialRole === "main-event"
      );
      markRejected(
        record,
        "redundant",
        `related-group kept ${main?.cluster.clusterId || "main-event"} as main-event`
      );
    }
  }

  for (const record of majorCandidates) {
    if (record.decision) continue;
    if (selected.length >= config.digestMax) {
      noteSkip(record, "digest-size", "digest already at max");
      continue;
    }
    const majorsSoFar = selected.filter((entry) => entry.lane === "major").length;
    if (majorsSoFar >= config.majorCap) {
      noteSkip(record, "lower-priority", "major cap reached");
      continue;
    }
    if (!topicAllows(record, selected, "major", config, majorTopIds)) {
      noteSkip(record, "category-saturation", `topicGroup ${record.topicGroup} is saturated`);
      continue;
    }
    markSelected(record, "major-news", "major");
    record.editorialPriority = record.majorRank;
    selected.push(record);
  }

  const personalCandidates = records
    .filter(
      (record) =>
        record.eligible &&
        record.editorialRole === "main-event" &&
        record.passesPersonal &&
        record.decision !== "selected"
    )
    .sort(comparePersonal);

  for (const record of personalCandidates) {
    if (record.decision) continue;
    if (selected.length >= config.digestMax) {
      noteSkip(record, "digest-size", "digest already at max");
      continue;
    }
    const personalsSoFar = selected.filter((entry) => entry.lane === "personal").length;
    if (personalsSoFar >= config.personalCap) {
      noteSkip(record, "lower-priority", "personal cap reached");
      continue;
    }
    if (!topicAllows(record, selected, "personal", config, majorTopIds)) {
      noteSkip(record, "category-saturation", `topicGroup ${record.topicGroup} is saturated`);
      continue;
    }
    markSelected(record, "personal-interest", "personal");
    record.editorialPriority = record.personalRank;
    selected.push(record);
  }

  const generalCandidates = records
    .filter(
      (record) =>
        record.eligible &&
        record.editorialRole === "main-event" &&
        record.passesGeneral &&
        record.decision !== "selected"
    )
    .sort(compareGeneral);

  for (const record of generalCandidates) {
    if (record.decision) continue;
    if (selected.length >= config.digestTarget) {
      noteSkip(record, "digest-size", "digest target reached");
      continue;
    }
    if (selected.length >= config.digestMax) {
      noteSkip(record, "digest-size", "digest already at max");
      continue;
    }
    if (!topicAllows(record, selected, "general", config, majorTopIds)) {
      noteSkip(record, "category-saturation", `topicGroup ${record.topicGroup} is saturated`);
      continue;
    }
    markSelected(record, "general-high-value", "general");
    record.editorialPriority = record.cluster.baseScore;
    selected.push(record);
  }

  for (const record of records) {
    if (record.decision) continue;
    if (record.skipReason) {
      markRejected(record, record.skipReason.reason, record.skipReason.detail);
      continue;
    }
    if (!record.passesMajor && !record.passesPersonal && !record.passesGeneral) {
      markRejected(record, "below-lane-threshold", "did not pass major, personal, or general gates");
      continue;
    }
    markRejected(record, "lower-priority", "not taken in pack order");
  }

  selected.forEach((record, index) => {
    record.rank = index + 1;
  });

  return { selected, majorTopIds };
}
