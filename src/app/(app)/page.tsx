import { redirect } from "next/navigation";

/**
 * There is no dashboard: `/` exists only to send a signed-in visitor to
 * `/articles`, the first item in the sidebar and the page every session
 * actually wants. `redirect()` throws before anything here could reach
 * SQLite, so this route needs no `connection()` call -- unlike every other
 * page listed in CLAUDE.md's `connection()` bullet, it never touches the
 * database at all.
 */
export default function RootPage() {
  redirect("/articles");
}
