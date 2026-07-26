import { Person, Relationship } from "@/types";

export interface SpouseData {
  person: Person;
  note?: string | null;
}

export interface AdjacencyLists {
  spousesByPersonId: Map<string, SpouseData[]>;
  childrenByPersonId: Map<string, Person[]>;
}

export interface TreeFilterOptions {
  hideDaughtersInLaw: boolean;
  hideSonsInLaw: boolean;
  hideDaughters: boolean;
  hideSons: boolean;
  hideMales: boolean;
  hideFemales: boolean;
}

/**
 * Keep only relationships that can be resolved against the loaded people and
 * remove duplicates. The CSV source describes a household as one box (the
 * bloodline member plus their spouse), while the database stores that box as
 * a marriage relationship. This normalisation makes every visualisation use
 * the same family edges.
 */
export function normalizeFamilyRelationships(
  relationships: Relationship[],
  personsMap: Map<string, Person>,
): Relationship[] {
  const normalized: Relationship[] = [];
  const seen = new Set<string>();

  const add = (relationship: Relationship) => {
    const { person_a, person_b, type } = relationship;
    if (
      person_a === person_b ||
      !personsMap.has(person_a) ||
      !personsMap.has(person_b)
    ) {
      return;
    }

    const pair =
      type === "marriage"
        ? [person_a, person_b].sort().join(":")
        : `${person_a}:${person_b}`;
    const key = `${type}:${pair}`;
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(relationship);
  };

  relationships.forEach(add);

  // Some older imports retained the spouse name in `note` but lost the
  // marriage row. Recover that edge when the name is unambiguous. This is
  // especially important for in-law members, who otherwise look orphaned in
  // every tree even though the family data has their spouse explicitly.
  const peopleByName = new Map<string, Person[]>();
  personsMap.forEach((person) => {
    const name = person.full_name.trim().toLocaleLowerCase("vi");
    const matches = peopleByName.get(name) ?? [];
    matches.push(person);
    peopleByName.set(name, matches);
  });

  const spousePairPattern = /(?:vợ|chồng)\s+của\s+(.+?)(?:[.!;,]|$)/iu;
  personsMap.forEach((person) => {
    const spouseName = person.note?.match(spousePairPattern)?.[1]?.trim();
    if (!spouseName) return;

    const matches = peopleByName.get(spouseName.toLocaleLowerCase("vi")) ?? [];
    if (matches.length !== 1) return;

    const spouse = matches[0];
    const inferredId = `inferred-marriage:${[person.id, spouse.id]
      .sort()
      .join(":")}`;
    add({
      id: inferredId,
      type: "marriage",
      person_a: person.id,
      person_b: spouse.id,
      note: "Suy ra từ thông tin vợ/chồng trong dữ liệu gia đình",
      created_at: "",
      updated_at: "",
      is_inferred: true,
    });
  });

  return normalized;
}

/**
 * Select one canonical root for each connected family component. A spouse is
 * not a root when their partner is part of the bloodline; the component's
 * explicit parent-child edges remain the authority, not the branch label in a
 * note. Branch labels are presentation metadata only.
 */
export function getFamilyRoots(
  persons: Person[],
  relationships: Relationship[],
  selectedRootId?: string | null,
): { personsMap: Map<string, Person>; roots: Person[]; defaultRootId?: string } {
  const personsMap = new Map(persons.map((person) => [person.id, person]));
  const familyRelationships = normalizeFamilyRelationships(
    relationships,
    personsMap,
  );

  const childIds = new Set(
    familyRelationships
      .filter(
        (relationship) =>
          relationship.type === "biological_child" ||
          relationship.type === "adopted_child",
      )
      .map((relationship) => relationship.person_b),
  );
  const graph = new Map<string, Set<string>>();
  familyRelationships.forEach((relationship) => {
    if (!graph.has(relationship.person_a)) {
      graph.set(relationship.person_a, new Set());
    }
    if (!graph.has(relationship.person_b)) {
      graph.set(relationship.person_b, new Set());
    }
    graph.get(relationship.person_a)!.add(relationship.person_b);
    graph.get(relationship.person_b)!.add(relationship.person_a);
  });

  const personIndex = new Map(persons.map((person, index) => [person.id, index]));
  const roots: Person[] = [];
  const visited = new Set<string>();

  const sortRootCandidates = (candidateIds: string[]) =>
    candidateIds.slice().sort((a, b) => {
      const personA = personsMap.get(a)!;
      const personB = personsMap.get(b)!;
      return (
        Number(personA.is_in_law) - Number(personB.is_in_law) ||
        (personA.generation ?? Infinity) - (personB.generation ?? Infinity) ||
        (personA.birth_order ?? Infinity) - (personB.birth_order ?? Infinity) ||
        (personIndex.get(a) ?? Infinity) - (personIndex.get(b) ?? Infinity)
      );
    });

  persons.forEach((person) => {
    if (visited.has(person.id)) return;

    const component: string[] = [];
    const queue = [person.id];
    visited.add(person.id);
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      component.push(currentId);
      for (const neighbor of graph.get(currentId) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    const candidates = component.filter((id) => !childIds.has(id));
    const sortedCandidates = sortRootCandidates(
      candidates.length > 0 ? candidates : component,
    );
    const root = sortedCandidates[0] && personsMap.get(sortedCandidates[0]);
    if (root) roots.push(root);
  });

  const selectedRoot = selectedRootId ? personsMap.get(selectedRootId) : null;
  const finalRoots = selectedRoot ? [selectedRoot] : roots;
  const defaultRootId = selectedRoot?.id ?? roots[0]?.id;

  return { personsMap, roots: finalRoots, defaultRootId };
}

/**
 * Xây dựng danh sách kề (adjacency lists) cho vợ/chồng và con cái từ dữ liệu thô.
 * Giúp tối ưu truy vấn từ O(N) xuống O(1).
 */
export function buildAdjacencyLists(
  relationships: Relationship[],
  personsMap: Map<string, Person>,
): AdjacencyLists {
  const spouses = new Map<string, SpouseData[]>();
  const children = new Map<string, Person[]>();

  normalizeFamilyRelationships(relationships, personsMap).forEach((r) => {
    if (r.type === "marriage") {
      if (!spouses.has(r.person_a)) spouses.set(r.person_a, []);
      if (!spouses.has(r.person_b)) spouses.set(r.person_b, []);

      const pB = personsMap.get(r.person_b);
      if (pB) spouses.get(r.person_a)!.push({ person: pB, note: r.note });

      const pA = personsMap.get(r.person_a);
      if (pA) spouses.get(r.person_b)!.push({ person: pA, note: r.note });
    } else if (r.type === "biological_child" || r.type === "adopted_child") {
      const child = personsMap.get(r.person_b);
      if (!child) return;
      if (!children.has(r.person_a)) children.set(r.person_a, []);
      children.get(r.person_a)!.push(child);
    }
  });

  // Sắp xếp con cái theo thứ tự sinh hoặc năm sinh
  children.forEach((childArray) => {
    childArray.sort((a, b) => {
      const aOrder = a.birth_order ?? Infinity;
      const bOrder = b.birth_order ?? Infinity;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aYear = a.birth_year ?? Infinity;
      const bYear = b.birth_year ?? Infinity;
      return aYear - bYear;
    });
  });

  return { spousesByPersonId: spouses, childrenByPersonId: children };
}

/**
 * Lấy dữ liệu của một node trong cây (vợ chồng, con cái) đã qua bộ lọc.
 */
export function getFilteredTreeData(
  personId: string,
  personsMap: Map<string, Person>,
  adj: AdjacencyLists,
  filters: TreeFilterOptions,
) {
  const {
    hideDaughtersInLaw,
    hideSonsInLaw,
    hideDaughters,
    hideSons,
    hideMales,
    hideFemales,
  } = filters;

  let spousesList = adj.spousesByPersonId.get(personId) || [];
  spousesList = spousesList.filter((s) => {
    if (hideDaughtersInLaw && s.person.gender === "female") return false;
    if (hideSonsInLaw && s.person.gender === "male") return false;
    if (hideMales && s.person.gender === "male") return false;
    if (hideFemales && s.person.gender === "female") return false;
    return true;
  });

  let childrenList = adj.childrenByPersonId.get(personId) || [];
  childrenList = childrenList.filter((c) => {
    if (hideDaughters && c.gender === "female") return false;
    if (hideSons && c.gender === "male") return false;
    if (hideMales && c.gender === "male") return false;
    if (hideFemales && c.gender === "female") return false;
    return true;
  });

  return {
    person: personsMap.get(personId)!,
    spouses: spousesList,
    children: childrenList,
  };
}
