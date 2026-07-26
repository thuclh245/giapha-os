import { MemberListProvider } from "@/context/MemberListContext";
import MembersViews from "@/components/MembersViews";
import MemberDetailModal from "@/components/modal/MemberDetailModal";
import ViewToggle from "@/components/ViewToggle";
import { getProfile, getSupabase } from "@/utils/supabase/queries";

import { ViewMode } from "@/components/ViewToggle";

interface PageProps {
  searchParams: Promise<{ view?: string; rootId?: string; avatar?: string }>;
}
export default async function FamilyTreePage({ searchParams }: PageProps) {
  const { view, rootId, avatar } = await searchParams;
  const initialView = view as ViewMode | undefined;
  const initialShowAvatar = avatar !== "hide";

  const profile = await getProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "editor";

  // If view is list, we only need persons, not relationships.
  // We fetch persons for all views to pass down as a prop if we want, or let components fetch.
  // Actually, to make transitions fast and avoid duplicate fetching across components,
  // we will fetch data here and pass it down as props.
  const supabase = await getSupabase();

  const [personsRes, relsRes] = await Promise.all([
    supabase
      .from("persons")
      .select("*")
      .order("birth_year", { ascending: true, nullsFirst: false }),
    supabase.from("relationships").select("*"),
  ]);

  const persons = personsRes.data || [];
  const relationships = relsRes.data || [];

  return (
    <MemberListProvider
      initialView={initialView}
      // Không tự chọn một gốc khi chưa có rootId để có thể hiển thị
      // tất cả các nhánh/chi độc lập trong cùng một gia phả.
      initialRootId={rootId ?? null}
      initialShowAvatar={initialShowAvatar}
    >
      <ViewToggle />
      <MembersViews
        persons={persons}
        relationships={relationships}
        canEdit={canEdit}
      />

      <MemberDetailModal />
    </MemberListProvider>
  );
}
