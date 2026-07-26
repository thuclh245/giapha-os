import { Person } from "@/types";

export function getLineageBranch(person: Person): number | null {
  const match = person.note?.match(
    /(?:\bChi\s*(?:thứ\s*)?|Người đứng đầu\s*Chi\s*)(?:[:#]\s*)?(\d+)/i,
  );
  return match ? Number(match[1]) : null;
}

export function getLineageHeadBranch(person: Person): number | null {
  const match = person.note?.match(/Người đứng đầu Chi\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function isCrossLineageParentChild(parent: Person, child: Person) {
  const parentBranch = getLineageBranch(parent);
  const childBranch = getLineageBranch(child);

  return (
    parentBranch != null &&
    childBranch != null &&
    parentBranch !== childBranch
  );
}
