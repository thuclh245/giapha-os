"use server";

import { Relationship } from "@/types";
import { getIsAdmin, getSupabase } from "@/utils/supabase/queries";
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Payload shape cho file backup JSON.
 * Các field DB-managed (created_at, updated_at) được giữ để tham khảo
 * nhưng sẽ bị loại bỏ khi import lại.
 */
interface PersonExport {
  id: string;
  full_name: string;
  gender: "male" | "female" | "other";
  birth_year: number | null;
  birth_month: number | null;
  birth_day: number | null;
  death_year: number | null;
  death_month: number | null;
  death_day: number | null;
  death_lunar_year: number | null;
  death_lunar_month: number | null;
  death_lunar_day: number | null;
  is_deceased: boolean;
  is_in_law: boolean;
  birth_order: number | null;
  generation: number | null;
  other_names: string | null;
  avatar_url: string | null;
  note: string | null;
  // DB-managed fields (kept in export for traceability, stripped on import)
  created_at?: string;
  updated_at?: string;
}

interface RelationshipExport {
  id?: string;
  type: string;
  person_a: string;
  person_b: string;
  note?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface PersonDetailsPrivateExport {
  person_id: string;
  phone_number: string | null;
  occupation: string | null;
  current_residence: string | null;
}

interface CustomEventExport {
  id: string;
  name: string;
  content: string | null;
  event_date: string;
  location: string | null;
  created_by: string | null;
}

interface BackupPayload {
  version: number;
  timestamp: string;
  persons: PersonExport[];
  relationships: RelationshipExport[];
  person_details_private?: PersonDetailsPrivateExport[];
  custom_events?: CustomEventExport[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

// Các field được phép insert vào bảng persons (loại bỏ created_at/updated_at)
function sanitizePerson(
  p: PersonExport,
): Omit<PersonExport, "created_at" | "updated_at"> {
  return {
    id: p.id,
    full_name: p.full_name,
    gender: p.gender,
    birth_year: p.birth_year ?? null,
    birth_month: p.birth_month ?? null,
    birth_day: p.birth_day ?? null,
    death_year: p.death_year ?? null,
    death_month: p.death_month ?? null,
    death_day: p.death_day ?? null,
    death_lunar_year: p.death_lunar_year ?? null,
    death_lunar_month: p.death_lunar_month ?? null,
    death_lunar_day: p.death_lunar_day ?? null,
    is_deceased: p.is_deceased ?? false,
    is_in_law: p.is_in_law ?? false,
    birth_order: p.birth_order ?? null,
    generation: p.generation ?? null,
    other_names: p.other_names ?? null,
    avatar_url: p.avatar_url ?? null,
    note: p.note ?? null,
  };
}

function sanitizeRelationship(
  r: RelationshipExport,
): Omit<RelationshipExport, "id" | "created_at" | "updated_at"> {
  return {
    type: r.type,
    person_a: r.person_a,
    person_b: r.person_b,
    note: r.note ?? null,
  };
}

function sanitizeCustomEvent(
  e: CustomEventExport,
): Omit<CustomEventExport, "created_by"> {
  return {
    id: e.id,
    name: e.name,
    content: e.content ?? null,
    event_date: e.event_date,
    location: e.location ?? null,
  };
}

function buildPersonIdMap(persons: PersonExport[]) {
  const idMap = new Map<string, string>();

  for (const person of persons) {
    idMap.set(person.id, isUuid(person.id) ? person.id : randomUUID());
  }

  return idMap;
}

function remapImportPayloadIds(
  importPayload: BackupPayload | {
    persons: PersonExport[];
    relationships: Relationship[];
    person_details_private?: PersonDetailsPrivateExport[];
    custom_events?: CustomEventExport[];
  },
) {
  const personIdMap = buildPersonIdMap(importPayload.persons);

  return {
    persons: importPayload.persons.map((person) => ({
      ...person,
      id: personIdMap.get(person.id)!,
    })),
    relationships: importPayload.relationships.map((relationship) => ({
      ...relationship,
      person_a: personIdMap.get(relationship.person_a) ?? relationship.person_a,
      person_b: personIdMap.get(relationship.person_b) ?? relationship.person_b,
    })),
    person_details_private: (importPayload.person_details_private ?? []).map(
      (details) => ({
        ...details,
        person_id: personIdMap.get(details.person_id) ?? details.person_id,
      }),
    ),
    custom_events: (importPayload.custom_events ?? []).map((event) => ({
      ...event,
      id: isUuid(event.id) ? event.id : randomUUID(),
    })),
  };
}

function inferBirthOrdersFromRelationshipOrder(
  persons: PersonExport[],
  relationships: Array<RelationshipExport | Relationship>,
): PersonExport[] {
  const nextPersons = persons.map((p) => ({ ...p }));
  const personsById = new Map(nextPersons.map((p) => [p.id, p]));
  const parentChildren = new Map<string, string[]>();

  for (const r of relationships) {
    if (r.type !== "biological_child" && r.type !== "adopted_child") continue;
    if (!r.person_a || !r.person_b) continue;

    if (!parentChildren.has(r.person_a)) parentChildren.set(r.person_a, []);
    const children = parentChildren.get(r.person_a)!;
    if (!children.includes(r.person_b)) {
      children.push(r.person_b);
    }
  }

  for (const [, childIds] of parentChildren) {
    const sourceOrder = new Map(childIds.map((id, index) => [id, index]));
    const sorted = [...childIds].sort((a, b) => {
      const pa = personsById.get(a);
      const pb = personsById.get(b);

      const aOrder = pa?.birth_order ?? null;
      const bOrder = pb?.birth_order ?? null;
      if (aOrder != null && bOrder != null && aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      const aYear = pa?.birth_year ?? Infinity;
      const bYear = pb?.birth_year ?? Infinity;
      if (aYear !== bYear) return aYear - bYear;

      const aSourceOrder = sourceOrder.get(a) ?? Infinity;
      const bSourceOrder = sourceOrder.get(b) ?? Infinity;
      if (aSourceOrder !== bSourceOrder) return aSourceOrder - bSourceOrder;

      return (pa?.full_name ?? "").localeCompare(pb?.full_name ?? "", "vi");
    });

    let order = 1;
    for (const childId of sorted) {
      const child = personsById.get(childId);
      if (!child || child.is_in_law) continue;
      if (child.birth_order == null) {
        child.birth_order = order;
      }
      order++;
    }
  }

  return nextPersons;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function exportData(
  exportRootId?: string,
): Promise<BackupPayload | { error: string }> {
  const isAdmin = await getIsAdmin();
  if (!isAdmin) {
    return { error: "Từ chối truy cập. Chỉ admin mới có quyền này." };
  }

  const supabase = await getSupabase();

  // Fetch ALL rows using pagination to avoid the 1000-row Supabase limit.
  const fetchAll = async (table: string, selectCols: string, orderBy: string) => {
    let allData: unknown[] = [];
    let from = 0;
    const step = 1000;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(selectCols)
        .order(orderBy, { ascending: true })
        .range(from, from + step - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allData = allData.concat(data as unknown[]);
      if (data.length < step) break;
      from += step;
    }
    return allData;
  };

  let allPersons: unknown[] = [];
  let allRels: unknown[] = [];
  let allPrivateDetails: unknown[] = [];
  let allCustomEvents: unknown[] = [];

  try {
    allPersons = await fetchAll(
      "persons",
      "id, full_name, gender, birth_year, birth_month, birth_day, death_year, death_month, death_day, death_lunar_year, death_lunar_month, death_lunar_day, is_deceased, is_in_law, birth_order, generation, other_names, avatar_url, note, created_at, updated_at",
      "created_at",
    );
    allRels = await fetchAll(
      "relationships",
      "id, type, person_a, person_b, note, created_at, updated_at",
      "created_at",
    );
    // person_details_private might not have created_at, order by person_id
    allPrivateDetails = await fetchAll(
      "person_details_private",
      "person_id, phone_number, occupation, current_residence",
      "person_id",
    );
    allCustomEvents = await fetchAll(
      "custom_events",
      "id, name, content, event_date, location, created_by",
      "event_date",
    );
  } catch (error: unknown) {
    return {
      error:
        "Lỗi tải dữ liệu: " +
        (error instanceof Error ? error.message : "Không rõ nguyên nhân"),
    };
  }

  let exportPersons = (allPersons ?? []) as PersonExport[];
  let exportRels = (allRels ?? []) as RelationshipExport[];
  let exportPrivateDetails = (allPrivateDetails ??
    []) as PersonDetailsPrivateExport[];
  const exportCustomEvents = (allCustomEvents ?? []) as CustomEventExport[];

  // If a root person is selected, filter the export to only their subtree
  if (exportRootId && exportPersons.some((p) => p.id === exportRootId)) {
    const includedPersonIds = new Set<string>([exportRootId]);

    // Pre-calculate adjacency lists for O(1) lookup to improve performance with large datasets
    const childrenMap = new Map<string, string[]>();
    const spouseMap = new Map<string, string[]>();

    exportRels.forEach((r) => {
      if (r.type === "biological_child" || r.type === "adopted_child") {
        if (!childrenMap.has(r.person_a)) childrenMap.set(r.person_a, []);
        childrenMap.get(r.person_a)!.push(r.person_b);
      } else if (r.type === "marriage") {
        if (!spouseMap.has(r.person_a)) spouseMap.set(r.person_a, []);
        if (!spouseMap.has(r.person_b)) spouseMap.set(r.person_b, []);
        spouseMap.get(r.person_a)!.push(r.person_b);
        spouseMap.get(r.person_b)!.push(r.person_a);
      }
    });

    // 1. Traverse biological and adopted children recursively
    const findDescendants = (parentId: string) => {
      const children = childrenMap.get(parentId) || [];
      children.forEach((childId) => {
        if (!includedPersonIds.has(childId)) {
          includedPersonIds.add(childId);
          findDescendants(childId);
        }
      });
    };
    findDescendants(exportRootId);

    // 2. Add spouses for everyone in the tree so far
    const descendantsArray = Array.from(includedPersonIds); // snapshot current members
    descendantsArray.forEach((personId) => {
      const spouses = spouseMap.get(personId) || [];
      spouses.forEach((spouseId) => {
        includedPersonIds.add(spouseId);
      });
    });

    // 3. Filter the payload
    exportPersons = exportPersons.filter((p) => includedPersonIds.has(p.id));
    exportRels = exportRels.filter(
      (r) =>
        includedPersonIds.has(r.person_a) && includedPersonIds.has(r.person_b),
    );
    exportPrivateDetails = exportPrivateDetails.filter((d) =>
      includedPersonIds.has(d.person_id),
    );
    // custom_events are not person-scoped, so export all when subtree is selected
  }

  return {
    version: 3, // v3: adds death_lunar_*, person_details_private, relationship note, custom_events
    timestamp: new Date().toISOString(),
    persons: exportPersons,
    relationships: exportRels,
    person_details_private: exportPrivateDetails,
    custom_events: exportCustomEvents,
  };
}

// ─── Import ───────────────────────────────────────────────────────────────────

export async function importData(
  importPayload:
    | BackupPayload
    | {
        persons: PersonExport[];
        relationships: Relationship[];
        person_details_private?: PersonDetailsPrivateExport[];
        custom_events?: CustomEventExport[];
      },
) {
  const isAdmin = await getIsAdmin();
  if (!isAdmin) {
    return { error: "Từ chối truy cập. Chỉ admin mới có quyền này." };
  }

  const supabase = await getSupabase();

  if (!importPayload?.persons || !importPayload?.relationships) {
    return { error: "Dữ liệu không hợp lệ. Vui lòng kiểm tra lại file JSON." };
  }

  if (importPayload.persons.length === 0) {
    return {
      error: "File backup trống — không có thành viên nào để phục hồi.",
    };
  }

  const duplicatePersonIds = importPayload.persons
    .map((p) => p.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);

  if (duplicatePersonIds.length > 0) {
    return {
      error:
        `File có mã thành viên bị trùng (${duplicatePersonIds[0]}). ` +
        "Đã hủy import để bảo toàn dữ liệu hiện tại.",
    };
  }

  // Validate all foreign-key references before deleting existing data.
  // Without this guard, a malformed backup could erase the current database
  // and only fail later while inserting relationships.
  const importedPersonIds = new Set(importPayload.persons.map((p) => p.id));
  const invalidRelationshipRefs = importPayload.relationships
    .filter((r) => r.person_a !== r.person_b)
    .filter(
      (r) =>
        !importedPersonIds.has(r.person_a) ||
        !importedPersonIds.has(r.person_b),
    );

  if (invalidRelationshipRefs.length > 0) {
    const example = invalidRelationshipRefs[0];
    return {
      error:
        `File có ${invalidRelationshipRefs.length} quan hệ tham chiếu đến thành viên không tồn tại ` +
        `(ví dụ: ${example.person_a} → ${example.person_b}). ` +
        "Đã hủy import để bảo toàn dữ liệu hiện tại.",
    };
  }

  const normalizedPayload = remapImportPayloadIds(importPayload);

  // 1. Xoá custom_events
  const { error: delEventsError } = await supabase
    .from("custom_events")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (delEventsError)
    return {
      error: "Lỗi khi xoá custom_events cũ: " + delEventsError.message,
    };

  // 2. Xoá relationships (FK constraint)
  const { error: delRelError } = await supabase
    .from("relationships")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (delRelError)
    return { error: "Lỗi khi xoá relationships cũ: " + delRelError.message };

  // 3. Xoá person_details_private (FK constraint on persons)
  const { error: delPrivateError } = await supabase
    .from("person_details_private")
    .delete()
    .neq("person_id", "00000000-0000-0000-0000-000000000000");

  if (delPrivateError)
    return {
      error:
        "Lỗi khi xoá person_details_private cũ: " + delPrivateError.message,
    };

  // 4. Xoá persons
  const { error: delPersonsError } = await supabase
    .from("persons")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (delPersonsError)
    return { error: "Lỗi khi xoá persons cũ: " + delPersonsError.message };

  // 5. Insert persons (sanitized — chỉ giữ các field schema hiện tại)
  const CHUNK = 200;
  const persons = inferBirthOrdersFromRelationshipOrder(
    normalizedPayload.persons,
    normalizedPayload.relationships,
  ).map(sanitizePerson);

  for (let i = 0; i < persons.length; i += CHUNK) {
    const chunk = persons.slice(i, i + CHUNK);
    const { error } = await supabase.from("persons").insert(chunk);
    if (error)
      return {
        error: `Lỗi khi import persons (chunk ${i / CHUNK + 1}): ${error.message}`,
      };
  }

  // 6. Insert relationships (stripped of id/created_at to avoid conflicts)
  // Filter out self-relationships to avoid "no_self_relationship" constraint violation
  const relationships = normalizedPayload.relationships
    .filter((r) => r.person_a !== r.person_b)
    .map(sanitizeRelationship);

  for (let i = 0; i < relationships.length; i += CHUNK) {
    const chunk = relationships.slice(i, i + CHUNK);
    const { error } = await supabase.from("relationships").insert(chunk);
    if (error)
      return {
        error: `Lỗi khi import relationships (chunk ${i / CHUNK + 1}): ${error.message}`,
      };
  }

  // 7. Insert person_details_private (if present in payload)
  let privateDetailsCount = 0;
  const privateDetails = normalizedPayload.person_details_private;
  if (privateDetails.length > 0) {
    for (let i = 0; i < privateDetails.length; i += CHUNK) {
      const chunk = privateDetails.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("person_details_private")
        .insert(chunk);
      if (error)
        return {
          error: `Lỗi khi import person_details_private (chunk ${i / CHUNK + 1}): ${error.message}`,
        };
    }
    privateDetailsCount = privateDetails.length;
  }

  // 8. Insert custom_events (if present in payload, strip created_by)
  let customEventsCount = 0;
  const customEvents = normalizedPayload.custom_events.map(sanitizeCustomEvent);
  if (customEvents.length > 0) {
    for (let i = 0; i < customEvents.length; i += CHUNK) {
      const chunk = customEvents.slice(i, i + CHUNK);
      const { error } = await supabase.from("custom_events").insert(chunk);
      if (error)
        return {
          error: `Lỗi khi import custom_events (chunk ${i / CHUNK + 1}): ${error.message}`,
        };
    }
    customEventsCount = customEvents.length;
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/members");
  revalidatePath("/dashboard/data");

  return {
    success: true,
    imported: {
      persons: persons.length,
      relationships: relationships.length,
      person_details_private: privateDetailsCount,
      custom_events: customEventsCount,
    },
  };
}
