import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"

const docs = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().int().nonnegative().optional(),
    navTitle: z.string().optional(),
    skill: z
      .object({
        include: z.boolean().default(true),
        entry: z.boolean().default(false),
        intents: z.array(z.string().trim().min(1)).default([]),
      })
      .optional(),
  }),
})

export const collections = {
  docs,
}
