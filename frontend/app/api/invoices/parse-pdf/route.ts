import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const invoiceSchema = z.object({
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

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File) || !file.type.includes("pdf")) {
      return NextResponse.json({ error: "Please provide a valid PDF file" }, { status: 400 });
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    // Convert PDF to base64
    const buffer = Buffer.from(await file.arrayBuffer());
    const dataUrl = `data:application/pdf;base64,${buffer.toString("base64")}`;

    const { object } = await generateObject({
      model: openai("gpt-4o"),
      schema: invoiceSchema,
      messages: [
        {
          role: "system",
          content: `Extract invoice data precisely:
            - Quantities: exact as shown (5 stays 5, not 300)
            - Rates: dollar amounts (e.g., $100.00 → 100)
            - Invoice #: patterns like #1234, INV-1234
            - Dates: YYYY-MM-DD format
            - Each line item separate in array`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract invoice data from this PDF:" },
            { type: "image", image: dataUrl },
          ],
        },
      ],
      temperature: 0.1,
    });

    return NextResponse.json(object);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to parse PDF" },
      { status: 500 },
    );
  }
}
