"use client";

import { Person } from "@/types";
import { useMemberListView } from "@/context/MemberListContext";
import PersonSelector from "./PersonSelector";

export default function RootSelector({
  persons,
  currentRootId,
}: {
  persons: Person[];
  currentRootId: string | null;
}) {
  const { setRootId } = useMemberListView();

  return (
    <PersonSelector
      persons={persons}
      selectedId={currentRootId}
      onSelect={(id) => {
        setRootId(id);
      }}
      placeholder="Chọn người..."
      label="Gốc hiển thị"
      showAllOption={true}
      allOptionLabel="Tất cả các chi"
      className="w-full sm:w-72"
    />
  );
}
