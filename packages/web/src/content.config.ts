import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"
import { packageLoader } from "./lib/package-loader"
import { packageEntrySchema } from "./lib/package-schema"

const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    draft: z.boolean().default(false),
    skill: z
      .object({
        include: z.boolean().default(true),
        entry: z.boolean().default(false),
        intents: z.array(z.string().trim().min(1)).default([]),
      })
      .optional(),
  }),
})

const scrollback = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/scrollback" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date(),
    author: z.string().optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    draft: z.boolean().default(false),
  }),
})

const packages = defineCollection({
  loader: packageLoader(),
  schema: packageEntrySchema,
})

export const collections = {
  docs,
  packages,
  scrollback,
}
