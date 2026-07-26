"use client";

import { useMemberListView } from "@/context/MemberListContext";
import MemberList from "@/components/MemberList";
import RootSelector from "@/components/RootSelector";
import { Person, Relationship } from "@/types";
import {
  getFamilyRoots,
  normalizeFamilyRelationships,
} from "@/utils/treeHelpers";
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
  const { personsMap, roots, defaultRootId, familyRelationships } = useMemo(() => {
    const tree = getFamilyRoots(persons, relationships, rootId);
    return {
      ...tree,
      familyRelationships: normalizeFamilyRelationships(
        relationships,
        tree.personsMap,
      ),
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
              relationships={familyRelationships}
              canEdit={canEdit}
            />
          </div>
        )}

        <div className="flex-1 w-full relative z-10">
          {currentView === "tree" && (
            <FamilyTree
              personsMap={personsMap}
              relationships={familyRelationships}
              roots={roots}
              canEdit={canEdit}
            />
          )}
          {currentView === "mindmap" && (
            <MindmapTree
              personsMap={personsMap}
              relationships={familyRelationships}
              roots={roots}
              canEdit={canEdit}
            />
          )}
          {currentView === "bubble" && (
            <BubbleMapTree
              personsMap={personsMap}
              relationships={familyRelationships}
              roots={roots}
              canEdit={canEdit}
            />
          )}
        </div>
      </main>
    </>
  );
}
