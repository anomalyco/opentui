import { getCollection, type CollectionEntry } from "astro:content"
import { channelApi } from "./api-docs"
import type { DocsChannel } from "./docs-channel"
import type { ReleaseNotesData } from "./release-notes-loader"
import { channelVersions, releaseLine } from "./release-notes"

export interface ChannelRelease {
  version: string
  line: string
  notes?: CollectionEntry<"releases">
  data?: ReleaseNotesData
}

/** The releases a channel lists, newest first (see channelVersions). */
export async function channelReleases(channel: DocsChannel): Promise<ChannelRelease[]> {
  const [notes, api] = await Promise.all([getCollection("releases"), channelApi(channel)])
  const notesByVersion = new Map(notes.map((entry) => [entry.id, entry]))
  return channelVersions(channel, [...notesByVersion.keys()], api?.versions ?? []).map((version) => {
    const entry = notesByVersion.get(version)
    return { version, line: releaseLine(version), notes: entry, data: entry?.data as ReleaseNotesData | undefined }
  })
}
