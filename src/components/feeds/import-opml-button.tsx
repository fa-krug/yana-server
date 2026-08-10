"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UploadIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { importOpmlFeeds, previewOpmlImport, type OpmlPreviewEntry } from "@/lib/feeds/actions";
import { attempt } from "@/lib/feeds/result";

const STATUS_VARIANT: Record<OpmlPreviewEntry["status"], "secondary" | "outline" | "destructive"> =
  {
    new: "secondary",
    duplicate: "outline",
    invalid: "destructive",
  };

export function ImportOpmlButton() {
  const t = useTranslations("feeds");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<OpmlPreviewEntry[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function statusLabel(status: OpmlPreviewEntry["status"]): string {
    if (status === "new") return t("importStatusNew");
    if (status === "duplicate") return t("importStatusDuplicate");
    return t("importStatusInvalid");
  }

  async function onFileSelected(file: File) {
    const text = await file.text();
    const result = await attempt(() => previewOpmlImport(text));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return;
    }
    setContent(text);
    setEntries(result.entries);
  }

  function close() {
    setEntries(null);
    setContent(null);
  }

  function confirm() {
    if (!content) return;
    start(async () => {
      const result = await attempt(() => importOpmlFeeds(content));
      if (!result.ok) {
        toast.error(t(result.errorKey));
        return;
      }
      toast.success(t("importResult", { imported: result.imported, skipped: result.skipped }));
      close();
      router.refresh();
    });
  }

  const newCount = entries?.filter((entry) => entry.status === "new").length ?? 0;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".opml,.xml,text/xml,text/x-opml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onFileSelected(file);
        }}
      />
      <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
        <UploadIcon />
        {t("importOpml")}
      </Button>

      <Dialog open={entries !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("importPreviewTitle", { count: entries?.length ?? 0 })}</DialogTitle>
          </DialogHeader>

          <div className="max-h-80 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.aggregator")}</TableHead>
                  <TableHead>{t("form.tags")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries?.map((entry, index) => (
                  <TableRow key={`${entry.identifier}-${index}`}>
                    <TableCell>{entry.name}</TableCell>
                    <TableCell>{entry.aggregatorLabel}</TableCell>
                    <TableCell>{entry.tags.join(", ")}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[entry.status]}>
                        {statusLabel(entry.status)}
                        {entry.reasonKey ? ` — ${t(entry.reasonKey)}` : ""}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={confirm} disabled={pending || newCount === 0}>
              {t("importConfirm", { count: newCount })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
