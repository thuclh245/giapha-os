"use client";

import { useMemberListView } from "@/context/MemberListContext";
import MemberList from "@/components/MemberList";
import RootSelector from "@/components/RootSelector";
import { Person, Relationship } from "@/types";
import { useEffect, useMemo, useRef } from "react";
import dynamic from "next/dynamic";

const FamilyTree = dynamic(() => import("@/components/FamilyTree"));
const MindmapTree = dynamic(() => import("@/components/MindmapTree"));
const BubbleMapTree = dynamic(
  () =>
    import("@/components/BubbleMapTree").catch((err) => {
      console.error("Failed to load BubbleMapTree:", err);
      return {
        default: () => (
          <div className="flex absolute inset-0 items-center justify-center p-4 text-center bg-stone-50 rounded-2xl border border-stone-200/60 shadow-inner text-stone-500">
            Tính năng này không được hỗ trợ trên trình duyệt của bạn. Vui lòng
            cập nhật hoặc sử dụng trình duyệt khác.
          </div>
        ),
      };
    }),
  { ssr: false },
);

interface MembersViewsProps {
  persons: Person[];
  relationships: Relationship[];
  canEdit?: boolean;
}

export default function MembersViews({
  persons,
  relationships,
  canEdit = false,
}: MembersViewsProps) {
  const { view: currentView, rootId } = useMemberListView();
  const hasRestored = useRef(false);

  // Prepare map and roots for tree views
  const { personsMap, roots, defaultRootId } = useMemo(() => {
    const pMap = new Map<string, Person>();
    persons.forEach((p) => pMap.set(p.id, p));

    const childIds = new Set(
      relationships
        .filter(
          (r) => r.type === "biological_child" || r.type === "adopted_child",
        )
        .map((r) => r.person_b),
    );

    // Group disconnected data into one representative root per family branch.
    // The imported Excel has four disconnected branches (Chi 1–4), while
    // spouses and people without recorded parents create many technical roots.
    const graph = new Map<string, Set<string>>();
    relationships.forEach((r) => {
      if (!graph.has(r.person_a)) graph.set(r.person_a, new Set());
      if (!graph.has(r.person_b)) graph.set(r.person_b, new Set());
      graph.get(r.person_a)!.add(r.person_b);
      graph.get(r.person_b)!.add(r.person_a);
    });

    const personIndex = new Map(persons.map((p, index) => [p.id, index]));
    const visited = new Set<string>();
    const rootsFallback: Person[] = [];

    for (const person of persons) {
      if (visited.has(person.id)) continue;

      const component: Person[] = [];
      const queue = [person.id];
      visited.add(person.id);
      while (queue.length > 0) {
        const id = queue.shift()!;
        const current = pMap.get(id);
        if (current) component.push(current);
        for (const neighbor of graph.get(id) ?? []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      const candidates = component.filter((p) => !childIds.has(p.id));
      const sortedCandidates = (candidates.length > 0 ? candidates : component)
        .slice()
        .sort(
          (a, b) =>
            (a.generation ?? Infinity) - (b.generation ?? Infinity) ||
            (personIndex.get(a.id) ?? 0) - (personIndex.get(b.id) ?? 0),
        );
      if (sortedCandidates[0]) rootsFallback.push(sortedCandidates[0]);
    }

    // Khi chưa chọn gốc cụ thể, giữ một root đại diện cho mỗi chi.
    const selectedRoot = rootId && pMap.has(rootId) ? pMap.get(rootId) : null;
    const calculatedRoots = selectedRoot
      ? [selectedRoot]
      : rootsFallback.length > 0
        ? rootsFallback
        : persons.length > 0
          ? [persons[0]]
          : [];
    const finalRootId = selectedRoot?.id ?? rootsFallback[0]?.id ?? persons[0]?.id;

    return {
      personsMap: pMap,
      roots: calculatedRoots,
      defaultRootId: finalRootId,
    };
  }, [persons, relationships, rootId]);

  const activeRootId = rootId || defaultRootId;

  // Không tự khôi phục root cũ: khi không có rootId trên URL,
  // mặc định phải hiển thị toàn bộ các chi độc lập.
  useEffect(() => {
    if (hasRestored.current) return;
    hasRestored.current = true;
  }, []);

  // Lưu lựa chọn vào localStorage
  useEffect(() => {
    if (!hasRestored.current) return;

    const timeout = setTimeout(() => {
      try {
        if (activeRootId) localStorage.setItem("members_rootId", activeRootId);
      } catch (e) {
        console.warn("Failed to write to localStorage:", e);
      }
    }, 100);

    return () => clearTimeout(timeout);
  }, [currentView, activeRootId]);

  return (
    <>
      <main className="flex-1 overflow-auto bg-stone-50/50 flex flex-col">
        {currentView !== "list" && persons.length > 0 && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2 w-full flex flex-col sm:flex-row flex-wrap items-center sm:justify-between gap-4 relative z-20">
            <RootSelector persons={persons} currentRootId={rootId} />
            <div
              id="tree-toolbar-portal"
              className="flex items-center gap-2 flex-wrap justify-center"
            />
          </div>
        )}

        {currentView === "list" && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full relative z-10">
            <MemberList
              initialPersons={persons}
              relationships={relationships}
              canEdit={canEdit}
            />
          </div>
        )}

        <div className="flex-1 w-full relative z-10">
          {currentView === "tree" && (
            <FamilyTree
              personsMap={personsMap}
              relationships={relationships}
              roots={roots}
              canEdit={canEdit}
            />
          )}
          {currentView === "mindmap" && (
            <MindmapTree
              personsMap={personsMap}
              relationships={relationships}
              roots={roots}
              canEdit={canEdit}
            />
          )}
          {currentView === "bubble" && (
            <BubbleMapTree
              personsMap={personsMap}
              relationships={relationships}
              roots={roots}
              canEdit={canEdit}
            />
          )}
        </div>
      </main>
    </>
  );
}
