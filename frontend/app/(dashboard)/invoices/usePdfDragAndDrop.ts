import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

const parsedInvoiceSchema = z.object({
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number(),
        rate: z.number().optional(),
        amount: z.number().optional(),
      }),
    )
    .optional(),
  expenses: z
    .array(
      z.object({
        description: z.string(),
        amount: z.number(),
        category: z.string().optional(),
      }),
    )
    .optional(),
  notes: z.string().optional(),
});

export type ParsedInvoiceData = z.infer<typeof parsedInvoiceSchema>;

export function usePdfDragAndDrop({ onPdfParsed }: { onPdfParsed: (data: ParsedInvoiceData, file: File) => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragCounter = useRef(0);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      setIsDragging(false);
      dragCounter.current = 0;
      setError(null);

      const pdfFile = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type === "application/pdf");
      if (!pdfFile) {
        setError("Please drop a PDF file");
        return;
      }

      setIsParsing(true);
      try {
        const formData = new FormData();
        formData.append("file", pdfFile);

        const response = await fetch("/api/invoices/parse-pdf", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const { error } = await response.json().catch(() => ({ error: "Failed to parse PDF" }));
          throw new Error(error);
        }

        const data = parsedInvoiceSchema.parse(await response.json());
        onPdfParsed(data, pdfFile);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to parse PDF");
      } finally {
        setIsParsing(false);
      }
    },
    [onPdfParsed],
  );

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer?.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (--dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => e.preventDefault(), []);

  useEffect(() => {
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  return { isDragging, isParsing, error, setError };
}
