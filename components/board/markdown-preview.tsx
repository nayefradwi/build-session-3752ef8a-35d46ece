"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/client/utils";

/**
 * Shared markdown renderer used by the task-detail read view and the
 * write-mode editor's Preview tab. Centralising the styling here keeps the
 * preview's appearance identical to the eventual rendered description, so
 * what the author sees in Preview matches what readers will see on the card.
 *
 * `remarkGfm` enables GitHub-flavored markdown (tables, task lists,
 * strikethrough, autolinks) — common in task descriptions and free to add.
 *
 * Note: `react-markdown` ≥9 disables raw HTML by default, which is exactly
 * what we want here (descriptions come from authenticated team members but
 * we still don't trust them with arbitrary HTML).
 */
export function MarkdownPreview({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Plain prose-ish styling without pulling in the typography plugin —
        // just enough to make the description readable inside the modal.
        "text-sm leading-relaxed text-foreground",
        "[&>*+*]:mt-3",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80",
        "[&_p]:m-0",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:mt-1",
        "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Force any rendered link to open in a new tab so a user clicking
        // through doesn't lose the modal's surrounding context.
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              {...rest}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
