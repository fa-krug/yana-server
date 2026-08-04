"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export interface JobLogLine {
  id: number;
  stream: "stdout" | "stderr";
  line: string;
  createdAt: string;
}

export function JobLogViewer({
  jobId,
  initialLines,
}: {
  jobId: number;
  initialLines: JobLogLine[];
}) {
  const t = useTranslations("jobs");
  const [lines, setLines] = useState(initialLines);
  const [ended, setEnded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(initialLines.at(-1)?.id ?? 0);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/log-stream?after=${lastIdRef.current}`);

    source.addEventListener("line", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as JobLogLine;
      lastIdRef.current = line.id;
      setLines((prev) => [...prev, line]);
    });

    source.addEventListener("end", () => {
      setEnded(true);
      source.close();
    });

    return () => source.close();
  }, [jobId]);

  useEffect(() => {
    const container = containerRef.current;
    if (container && typeof container.scrollTo === "function") {
      container.scrollTo({ top: container.scrollHeight });
    }
  }, [lines]);

  return (
    <div
      ref={containerRef}
      className="max-h-96 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs"
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{t("logEmpty")}</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.id}
            className={cn("whitespace-pre-wrap", line.stream === "stderr" && "text-destructive")}
          >
            {line.line}
          </div>
        ))
      )}
      {ended && <p className="mt-2 text-muted-foreground">{t("logEnded")}</p>}
    </div>
  );
}
