import { Skeleton } from "@/components/ui/skeleton";

export function TableSkeleton({ rows = 8, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-2">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border p-4" aria-busy="true">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
