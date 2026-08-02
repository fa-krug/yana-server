"use client";

import { useState } from "react";

import type { BlockNode as BlockNodeType } from "@/lib/blocks/tree";
import { Button } from "@/components/ui/button";
import { BlockNode } from "./block-node";

export function BlockTree({ nodes }: { nodes: BlockNodeType[] }) {
  const [view, setView] = useState<"rendered" | "json">("rendered");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end space-x-2">
        <Button
          variant={view === "rendered" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("rendered")}
        >
          Rendered
        </Button>
        <Button
          variant={view === "json" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("json")}
        >
          Raw JSON
        </Button>
      </div>

      {view === "json" ? (
        <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs">
          <code>{JSON.stringify(nodes, null, 2)}</code>
        </pre>
      ) : (
        <div className="space-y-4">
          {nodes.map((node) => (
            <BlockNode key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}
