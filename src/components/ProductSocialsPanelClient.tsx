'use client'

import { Button, toast, useConfig, useDocumentInfo, useListDrawer } from '@payloadcms/ui'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { PlatformId } from '../constants.js'
import type {
  PlatformCapabilities,
  PreviewResult,
  PublishedRef,
  SocialDraft,
  SocialDraftMedia,
  ValidationResult,
} from '../types/index.js'

import { PLATFORM_IDS, PLATFORM_LABELS } from '../constants.js'
import {
  acceptedMediaTypes,
  buildInitialComposerState,
  buildStandaloneInitialState,
  compileComposerInput,
  compileStandalonePublishBody,
  type ComposerState,
  getEffectiveAssets,
  type MediaType,
  parseComposeResponse,
  pruneSelectedMedia,
  shouldFetchEnvelope,
  type StandaloneComposerState,
  supportsMultipleMedia,
} from './socialComposerModel.js'
import './SocialPublishPanelClient.scss'

type Props = {
  mode?: 'source' | 'standalone'
  sourceKind?: string
}
type Destination = { id: string; label: string }
type HistoryRow = {
  externalUrl?: string
  id: number | string
  publishedAt?: string
  status?: string
}
type ResolvedTemplate = {
  appliesTo: PlatformId[]
  description?: string
  id: number | string
  name: string
  resolved: {
    facebookMessage?: string
    gbpSummary?: string
    instagramCaption?: string
    pinterestAltText?: string
    pinterestDescription?: string
    pinterestHashtags?: string[]
    pinterestTitle?: string
  }
}
type PreviewEnvelope = {
  capabilities: PlatformCapabilities
  draft: SocialDraft
  error?: string
  preview: PreviewResult
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

const platformFormats: Record<PlatformId, Array<{ label: string; value: string }>> = {
  facebook: [
    { label: 'Link or text', value: 'LINK' },
    { label: 'Single photo', value: 'PHOTO' },
    { label: 'Photo gallery', value: 'PHOTO_MULTI' },
    { label: 'Video', value: 'VIDEO' },
  ],
  gbp: [
    { label: 'Update', value: 'STANDARD' },
    { label: 'Event', value: 'EVENT' },
    { label: 'Offer', value: 'OFFER' },
    { label: 'Alert', value: 'ALERT' },
  ],
  instagram: [
    { label: 'Image', value: 'IMAGE' },
    { label: 'Reel', value: 'REELS' },
    { label: 'Story', value: 'STORIES' },
    { label: 'Carousel', value: 'CAROUSEL' },
  ],
  pinterest: [
    { label: 'Image Pin', value: 'IMAGE' },
    { label: 'Video Pin', value: 'VIDEO' },
  ],
}

const destinationPath: Record<PlatformId, string> = {
  facebook: '/facebook/pages',
  gbp: '/gbp/locations',
  instagram: '/instagram/accounts',
  pinterest: '/pinterest/boards',
}

/** Infer media type from URL extension or mime type. */
const inferMediaType = (url: string, mimeType?: string): MediaType => {
  if (mimeType) {
    if (mimeType.startsWith('video/')) {
      return 'video'
    }
    return 'image'
  }
  const ext = url.split('.').pop()?.split('?')[0]?.toLowerCase() ?? ''
  if (['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm'].includes(ext)) {
    return 'video'
  }
  return 'image'
}

/** Extract format string from mimeType or URL extension. */
const inferFormat = (url: string, mimeType?: string): string | undefined => {
  if (mimeType) {
    const sub = mimeType.split('/')[1]
    if (sub) {
      return sub.split(';')[0]
    }
  }
  const ext = url.split('.').pop()?.split('?')[0]?.toLowerCase()
  return ext || undefined
}

// ===========================================================================
// Source-mode composer (existing behavior, overhauled)
// ===========================================================================

const SourceComposer: React.FC<{ sourceKind: string }> = ({ sourceKind }) => {
  const { id } = useDocumentInfo()
  const { config } = useConfig()

  // Fix 1: read from config.admin?.custom (serialized to browser) instead of
  // config.custom (stripped by Payload 3.86 serverOnlyConfigProperties).
  const socials = asRecord(asRecord(config.admin?.custom)?.socials)

  const enabledPlatforms = Array.isArray(socials?.enabledPlatforms)
    ? socials.enabledPlatforms.filter(
        (value): value is PlatformId =>
          typeof value === 'string' && PLATFORM_IDS.includes(value as PlatformId),
      )
    : []
  const [platform, setPlatform] = useState<PlatformId>(enabledPlatforms[0] ?? 'pinterest')
  const [envelopes, setEnvelopes] = useState<Partial<Record<PlatformId, PreviewEnvelope>>>({})
  const [states, setStates] = useState<Partial<Record<PlatformId, ComposerState>>>({})
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [templates, setTemplates] = useState<ResolvedTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [scheduledAt, setScheduledAt] = useState('')
  const [validation, setValidation] = useState<ValidationResult>()
  const [publishedRef, setPublishedRef] = useState<PublishedRef>()
  const [loading, setLoading] = useState(false)
  // Two-step delete/mark-deleted confirm: stores the post id that is armed.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | string>()
  const [deletingId, setDeletingId] = useState<number | string>()

  // Fix 5 (source): destructure closeDrawer from the tuple.
  const [ListDrawer, , { closeDrawer, openDrawer }] = useListDrawer({
    collectionSlugs: undefined as never,
    uploads: true,
  })

  // URL input state
  const [urlInput, setUrlInput] = useState('')
  const [urlTypeOverride, setUrlTypeOverride] = useState<'image' | 'video'>('image')

  const apiRoute = typeof config.routes?.api === 'string' ? config.routes.api : '/api'
  const basePath = typeof socials?.apiBasePath === 'string' ? socials.apiBasePath : '/socials'
  const endpointBase = `${apiRoute.replace(/\/$/, '')}${basePath}`
  const sourceBase = useMemo(
    () =>
      `${endpointBase}/${platform}/${encodeURIComponent(sourceKind)}/${encodeURIComponent(String(id ?? ''))}`,
    [endpointBase, id, platform, sourceKind],
  )
  const envelope = envelopes[platform]
  const state = states[platform]
  const input = useMemo(
    () => (state && envelope ? compileComposerInput(platform, state, envelope.draft) : undefined),
    [envelope, platform, state],
  )

  const updateState = useCallback(
    (patch: Partial<ComposerState>): void => {
      setStates((current) => {
        const existing = current[platform]
        return existing ? { ...current, [platform]: { ...existing, ...patch } } : current
      })
    },
    [platform],
  )

  // Format change handler: prune invalid media and toast
  const handleFormatChange = useCallback(
    (newFormat: string): void => {
      setStates((current) => {
        const existing = current[platform]
        if (!existing) {
          return current
        }
        const draft = envelopes[platform]?.draft
        if (!draft) {
          return { ...current, [platform]: { ...existing, format: newFormat } }
        }
        const { pruned, removed } = pruneSelectedMedia(
          existing.selectedMedia,
          draft.media,
          platform,
          newFormat,
        )
        if (removed.length > 0) {
          toast.info(
            `${removed.length} media item${removed.length > 1 ? 's' : ''} removed (not available for this format)`,
          )
        }
        return {
          ...current,
          [platform]: { ...existing, format: newFormat, selectedMedia: pruned },
        }
      })
    },
    [envelopes, platform],
  )

  const loadHistory = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const historyResponse = await fetch(`${sourceBase}/history`, { signal })
        const historyBody = (await historyResponse.json()) as {
          error?: string
          posts?: HistoryRow[]
        }
        if (!historyResponse.ok) {
          throw new Error(historyBody.error ?? 'History failed')
        }
        setHistory(historyBody.posts ?? [])
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          toast.error(caught instanceof Error ? caught.message : String(caught))
        }
      }
    },
    [sourceBase],
  )

  // Fix 4: cache-first envelope loading. Only fetch the preview when no
  // envelope exists for this platform yet. This prevents overwriting media
  // the user added via Add URL / Media library on tab return.
  useEffect(() => {
    if (!id) {
      return
    }
    // Skip fetch if an envelope already exists for this platform.
    if (!shouldFetchEnvelope(envelopes, platform)) {
      return
    }
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const [previewResponse, historyResponse] = await Promise.all([
          fetch(`${sourceBase}/preview`, { signal: controller.signal }),
          fetch(`${sourceBase}/history`, { signal: controller.signal }),
        ])
        const previewBody = (await previewResponse.json()) as PreviewEnvelope
        const historyBody = (await historyResponse.json()) as {
          error?: string
          posts?: HistoryRow[]
        }
        if (!previewResponse.ok) {
          throw new Error(previewBody.error ?? 'Preview failed')
        }
        if (!historyResponse.ok) {
          throw new Error(historyBody.error ?? 'History failed')
        }
        setEnvelopes((current) => ({ ...current, [platform]: previewBody }))
        setStates((current) =>
          current[platform]
            ? current
            : { ...current, [platform]: buildInitialComposerState(platform, previewBody) },
        )
        setHistory(historyBody.posts ?? [])
      } catch (caught) {
        if (!controller.signal.aborted) {
          toast.error(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }
    void load()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, platform, sourceBase])
  // Note: envelopes intentionally omitted from deps — this effect is
  // cache-first: once an envelope exists it is never re-fetched by this effect.

  useEffect(() => {
    if (!id) {
      return
    }
    const controller = new AbortController()
    void fetch(
      `${endpointBase}/templates/${encodeURIComponent(sourceKind)}/${encodeURIComponent(String(id))}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const body = (await response.json()) as { templates?: ResolvedTemplate[] }
        if (response.ok) {
          setTemplates(body.templates ?? [])
        }
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [endpointBase, id, sourceKind])

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${endpointBase}${destinationPath[platform]}`, {
          signal: controller.signal,
        })
        const body = (await response.json()) as Record<string, unknown>
        if (!response.ok) {
          throw new Error(
            typeof body.error === 'string' ? body.error : 'Destination discovery failed',
          )
        }
        const values =
          platform === 'pinterest'
            ? body.boards
            : platform === 'facebook'
              ? body.pages
              : platform === 'instagram'
                ? body.accounts
                : body.locations
        const rows = Array.isArray(values)
          ? values.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined)
          : []
        const next = rows.flatMap((row) => {
          const idValue =
            platform === 'instagram' ? row.igUserId : platform === 'gbp' ? row.resourceName : row.id
          if (typeof idValue !== 'string') {
            return []
          }
          const label =
            [row.name, row.pageName, row.title, row.storeCode].find(
              (value): value is string => typeof value === 'string',
            ) ?? idValue
          return [{ id: idValue, label }]
        })
        setDestinations(next)
        if (next.length === 1) {
          setStates((current) => {
            const existing = current[platform]
            if (!existing || existing.destinationId) {
              return current
            }
            return { ...current, [platform]: { ...existing, destinationId: next[0].id } }
          })
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setDestinations([])
          toast.error(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }
    void load()
    return () => controller.abort()
  }, [endpointBase, platform])

  useEffect(() => {
    if (!input) {
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void fetch(`${sourceBase}/validate`, {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json()) as { validation?: ValidationResult }
          if (response.ok) {
            setValidation(body.validation)
          }
        })
        .catch(() => undefined)
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [input, sourceBase])

  const applyTemplate = (templateId: string): void => {
    setSelectedTemplateId(templateId)
    const template = templates.find((candidate) => String(candidate.id) === templateId)
    if (!template) {
      return
    }
    const resolved = template.resolved
    if (platform === 'pinterest') {
      const tags = resolved.pinterestHashtags?.join(' ')
      updateState({
        altText: resolved.pinterestAltText ?? state?.altText,
        copy: [resolved.pinterestDescription, tags].filter(Boolean).join('\n\n') || state?.copy,
        title: resolved.pinterestTitle ?? state?.title,
      })
    } else if (platform === 'instagram' && resolved.instagramCaption) {
      updateState({ copy: resolved.instagramCaption })
    } else if (platform === 'facebook' && resolved.facebookMessage) {
      updateState({ copy: resolved.facebookMessage })
    } else if (platform === 'gbp' && resolved.gbpSummary) {
      updateState({ copy: resolved.gbpSummary })
    }
  }

  const toggleMedia = (url: string): void => {
    if (!state) {
      return
    }
    if (!supportsMultipleMedia(platform, state.format)) {
      updateState({ selectedMedia: [url] })
      return
    }
    const selected = state.selectedMedia.includes(url)
      ? state.selectedMedia.filter((value) => value !== url)
      : [...state.selectedMedia, url]
    updateState({ selectedMedia: selected })
  }

  // Fix 5 (source): call closeDrawer before processing selection so the
  // drawer closes immediately. Payload's ListDrawer does not auto-close.
  const handleLibrarySelect = useCallback(
    async (doc: { collectionSlug: string; docID: string }) => {
      closeDrawer()
      try {
        const response = await fetch(`${apiRoute}/${doc.collectionSlug}/${doc.docID}`)
        if (!response.ok) {
          toast.error('Failed to load media document')
          return
        }
        const mediaDoc = (await response.json()) as Record<string, unknown>
        const mimeType = typeof mediaDoc.mimeType === 'string' ? mediaDoc.mimeType : undefined
        const type = inferMediaType('', mimeType)
        const format = inferFormat('', mimeType)

        // Determine the best URL: prefer the largest jpeg size for webp/avif images
        let url = typeof mediaDoc.url === 'string' ? mediaDoc.url : ''
        if (
          type === 'image' &&
          format &&
          ['avif', 'webp'].includes(format) &&
          mediaDoc.sizes &&
          typeof mediaDoc.sizes === 'object'
        ) {
          const sizes = mediaDoc.sizes as Record<string, Record<string, unknown>>
          let bestWidth = 0
          for (const [, sizeData] of Object.entries(sizes)) {
            const sizeUrl = sizeData?.url
            const sizeMime = sizeData?.mimeType
            const sizeWidth = typeof sizeData?.width === 'number' ? sizeData.width : 0
            if (
              typeof sizeUrl === 'string' &&
              typeof sizeMime === 'string' &&
              sizeMime.includes('jpeg') &&
              sizeWidth > bestWidth
            ) {
              bestWidth = sizeWidth
              url = sizeUrl
            }
          }
        }

        // Make URL absolute
        if (url.startsWith('/')) {
          url = `${window.location.origin}${url}`
        }

        const newAsset: SocialDraftMedia = {
          type,
          altText: typeof mediaDoc.alt === 'string' ? mediaDoc.alt : undefined,
          format,
          height: typeof mediaDoc.height === 'number' ? mediaDoc.height : undefined,
          url,
          width: typeof mediaDoc.width === 'number' ? mediaDoc.width : undefined,
        }

        setEnvelopes((current) => {
          const env = current[platform]
          if (!env) {
            return current
          }
          return {
            ...current,
            [platform]: {
              ...env,
              draft: {
                ...env.draft,
                media: [...env.draft.media, newAsset],
              },
            },
          }
        })
        toast.success('Media added from library')
      } catch {
        toast.error('Failed to load media from library')
      }
    },
    [apiRoute, closeDrawer, platform],
  )

  const handleAddByUrl = useCallback(() => {
    if (!urlInput.trim()) {
      return
    }
    const url = urlInput.trim()
    const type = urlTypeOverride
    const format = inferFormat(url)
    const newAsset: SocialDraftMedia = {
      type,
      format,
      url: url.startsWith('/') ? `${window.location.origin}${url}` : url,
    }

    setEnvelopes((current) => {
      const env = current[platform]
      if (!env) {
        return current
      }
      return {
        ...current,
        [platform]: {
          ...env,
          draft: {
            ...env.draft,
            media: [...env.draft.media, newAsset],
          },
        },
      }
    })
    setUrlInput('')
    toast.success('Media added by URL')
  }, [platform, urlInput, urlTypeOverride])

  const publish = async (): Promise<void> => {
    if (!input) {
      return
    }
    if (validation && !validation.ok) {
      toast.error('Resolve the validation errors before publishing.')
      return
    }
    setLoading(true)
    setPublishedRef(undefined)
    try {
      const body = { ...input }
      if (scheduledAt) {
        body.scheduledAt = new Date(scheduledAt).toISOString()
      }
      const response = await fetch(`${sourceBase}/publish`, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const result = (await response.json()) as {
        error?: string
        publishedRef?: PublishedRef
        scheduled?: boolean
      }
      if (!response.ok) {
        throw new Error(result.error ?? `Publish failed (${response.status})`)
      }
      const ref = result.publishedRef ?? { externalId: '', meta: { scheduled: true }, platform }
      setPublishedRef(ref)
      toast.success(ref.meta?.scheduled ? 'Scheduled successfully.' : 'Published successfully.')
      // Refresh the history list after a successful publish.
      await loadHistory()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  /**
   * Normal delete: calls the platform adapter upstream and soft-deletes the row.
   * Not used for Instagram (see markDeletedPost below).
   */
  const deletePost = async (postId: number | string): Promise<void> => {
    setDeletingId(postId)
    setConfirmingDeleteId(undefined)
    try {
      const response = await fetch(`${endpointBase}/posts/${encodeURIComponent(String(postId))}`, {
        method: 'DELETE',
      })
      const result = (await response.json()) as { error?: string; ok?: boolean }
      if (!response.ok) {
        throw new Error(result.error ?? `Delete failed (${response.status})`)
      }
      toast.success('Post deleted.')
      await loadHistory()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDeletingId(undefined)
    }
  }

  /**
   * Instagram reconcile path: skips the upstream API entirely and marks the row
   * deleted locally (deletedLocalOnly: true). Use this after manually deleting
   * the post in the Instagram app so the local ledger stays in sync.
   */
  const markDeletedPost = async (postId: number | string): Promise<void> => {
    setDeletingId(postId)
    setConfirmingDeleteId(undefined)
    try {
      const response = await fetch(
        `${endpointBase}/posts/${encodeURIComponent(String(postId))}?localOnly=true`,
        { method: 'DELETE' },
      )
      const result = (await response.json()) as { error?: string; ok?: boolean }
      if (!response.ok) {
        throw new Error(result.error ?? `Mark-deleted failed (${response.status})`)
      }
      toast.success('Post marked as deleted locally.')
      await loadHistory()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDeletingId(undefined)
    }
  }

  if (!id) {
    return (
      <section className="socials-composer">
        Save this document before publishing to socials.
      </section>
    )
  }
  if (!state || !envelope) {
    return (
      <section aria-busy="true" className="socials-composer">
        Loading social composer…
      </section>
    )
  }

  const filteredTemplates = templates.filter(
    (template) => template.appliesTo.length === 0 || template.appliesTo.includes(platform),
  )
  const assets = envelope.draft.media
  const accepted = acceptedMediaTypes(platform, state.format)
  const mediaRequired =
    state.format !== 'LINK' && state.format !== 'STANDARD' && state.format !== 'ALERT'
  const copyLimit = envelope.capabilities.limits.captionMaxChars

  // Whether the active platform uses the localOnly reconcile path instead of a
  // live upstream delete. Instagram posts cannot be removed via the API.
  const isInstagram = platform === 'instagram'

  return (
    <section className="socials-composer">
      <header className="socials-composer__header">
        <div>
          <h2>Social composer</h2>
          <p>Compose, validate, preview, and publish without leaving this document.</p>
        </div>
        <div aria-label="Social platform" className="socials-composer__tabs" role="tablist">
          {enabledPlatforms.map((idValue) => (
            <button
              aria-selected={platform === idValue}
              data-platform={idValue}
              key={idValue}
              onClick={() => {
                setPlatform(idValue)
                setSelectedTemplateId('')
              }}
              role="tab"
              type="button"
            >
              {PLATFORM_LABELS[idValue]}
            </button>
          ))}
        </div>
      </header>

      <div className="socials-composer__layout">
        <div className="socials-composer__fields" role="tabpanel">
          <label>
            Template
            <select
              onChange={(event) => applyTemplate(event.target.value)}
              value={selectedTemplateId}
            >
              <option value="">Platform defaults</option>
              {filteredTemplates.map((template) => (
                <option key={template.id} value={String(template.id)}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>

          <div className="socials-composer__row">
            <label>
              Destination
              <select
                onChange={(event) => updateState({ destinationId: event.target.value })}
                required
                value={state.destinationId}
              >
                <option value="">Select a destination…</option>
                {destinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Format
              <select
                onChange={(event) => handleFormatChange(event.target.value)}
                value={state.format}
              >
                {platformFormats[platform].map((format) => (
                  <option key={format.value} value={format.value}>
                    {format.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {platform === 'pinterest' && (
            <label>
              Pin title{' '}
              <input
                aria-label="Pin title"
                maxLength={100}
                onChange={(event) => updateState({ title: event.target.value })}
                value={state.title}
              />
            </label>
          )}

          {(platform === 'instagram' || platform === 'facebook') && (
            <label>
              Title (first line)
              <input
                aria-label="Title (first line)"
                onChange={(event) => updateState({ title: event.target.value })}
                placeholder="Optional. Becomes the first line of the caption/message."
                value={state.title}
              />
              <span className="socials-composer__count">
                Instagram and Facebook have no separate title field; this becomes the first line of
                the caption/message.
              </span>
            </label>
          )}

          <label>
            {platform === 'gbp'
              ? 'Summary'
              : platform === 'instagram'
                ? 'Caption'
                : platform === 'facebook'
                  ? 'Message'
                  : 'Description'}
            <textarea
              aria-label="Post copy"
              onChange={(event) => updateState({ copy: event.target.value })}
              rows={7}
              value={state.copy}
            />
            <span
              className={
                copyLimit && state.copy.length > copyLimit
                  ? 'socials-composer__count socials-composer__count--error'
                  : 'socials-composer__count'
              }
            >
              {state.copy.length}
              {copyLimit ? ` / ${copyLimit}` : ''} characters
            </span>
          </label>

          {(platform === 'pinterest' || (platform === 'facebook' && state.format === 'LINK')) && (
            <label>
              Outbound link{' '}
              <input
                aria-label="Outbound link"
                onChange={(event) => updateState({ link: event.target.value })}
                type="url"
                value={state.link}
              />
            </label>
          )}
          {((platform === 'pinterest' && state.format === 'IMAGE') ||
            (platform === 'instagram' && state.format === 'IMAGE') ||
            (platform === 'facebook' && state.format === 'PHOTO')) && (
            <label>
              Accessibility text{' '}
              <textarea
                aria-label="Accessibility text"
                onChange={(event) => updateState({ altText: event.target.value })}
                rows={3}
                value={state.altText}
              />
            </label>
          )}
          {platform === 'facebook' && state.format === 'VIDEO' && (
            <label>
              Video title{' '}
              <input
                aria-label="Video title"
                onChange={(event) => updateState({ videoTitle: event.target.value })}
                value={state.videoTitle}
              />
            </label>
          )}
          {platform === 'instagram' && state.format === 'REELS' && (
            <label className="socials-composer__check">
              <input
                aria-label="Also share Reel to Feed"
                checked={state.shareToFeed}
                onChange={(event) => updateState({ shareToFeed: event.target.checked })}
                type="checkbox"
              />{' '}
              Also share Reel to Feed
            </label>
          )}

          {platform === 'gbp' && (
            <>
              <div className="socials-composer__row">
                <label>
                  CTA{' '}
                  <select
                    onChange={(event) =>
                      updateState({
                        callToAction: event.target.value as ComposerState['callToAction'],
                      })
                    }
                    value={state.callToAction}
                  >
                    <option value="">No button</option>
                    {['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'].map((value) => (
                      <option key={value} value={value}>
                        {value.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                {state.callToAction !== 'CALL' && (
                  <label>
                    {state.format === 'OFFER' ? 'Redeem URL' : 'CTA URL'}{' '}
                    <input
                      aria-label={state.format === 'OFFER' ? 'Redeem URL' : 'CTA URL'}
                      onChange={(event) => updateState({ callToActionUrl: event.target.value })}
                      type="url"
                      value={state.callToActionUrl}
                    />
                  </label>
                )}
              </div>
              {(state.format === 'EVENT' || state.format === 'OFFER') && (
                <>
                  <label>
                    Event title{' '}
                    <input
                      aria-label="Event title"
                      onChange={(event) => updateState({ eventTitle: event.target.value })}
                      value={state.eventTitle}
                    />
                  </label>
                  <div className="socials-composer__row">
                    <label>
                      Starts{' '}
                      <input
                        aria-label="Event starts"
                        onChange={(event) => updateState({ eventStart: event.target.value })}
                        type="datetime-local"
                        value={state.eventStart}
                      />
                    </label>
                    <label>
                      Ends{' '}
                      <input
                        aria-label="Event ends"
                        onChange={(event) => updateState({ eventEnd: event.target.value })}
                        type="datetime-local"
                        value={state.eventEnd}
                      />
                    </label>
                  </div>
                </>
              )}
              {state.format === 'OFFER' && (
                <div className="socials-composer__row">
                  <label>
                    Coupon code{' '}
                    <input
                      aria-label="Coupon code"
                      onChange={(event) => updateState({ offerCode: event.target.value })}
                      value={state.offerCode}
                    />
                  </label>
                  <label>
                    Terms{' '}
                    <textarea
                      aria-label="Offer terms"
                      onChange={(event) => updateState({ offerTerms: event.target.value })}
                      rows={3}
                      value={state.offerTerms}
                    />
                  </label>
                </div>
              )}
              {state.format === 'ALERT' && (
                <label>
                  Alert type{' '}
                  <select
                    onChange={(event) =>
                      updateState({ alertType: event.target.value as ComposerState['alertType'] })
                    }
                    value={state.alertType}
                  >
                    <option value="">Select…</option>
                    <option value="COVID_19">COVID-19</option>
                  </select>
                </label>
              )}
              <label>
                Language code (optional){' '}
                <input
                  aria-label="Language code"
                  onChange={(event) => updateState({ languageCode: event.target.value })}
                  placeholder="en-US"
                  value={state.languageCode}
                />
              </label>
            </>
          )}

          {(mediaRequired || assets.length > 0) && (
            <fieldset className="socials-composer__media">
              <legend>
                Media{' '}
                {supportsMultipleMedia(platform, state.format) ? '(choose and order 2-10)' : ''}
              </legend>
              {assets.length === 0 && <p>No source media is available.</p>}
              <div className="socials-composer__media-grid">
                {assets.map((asset) => {
                  const selected = state.selectedMedia.includes(asset.url)
                  const isAccepted = accepted.includes(asset.type)
                  return (
                    <button
                      aria-label={
                        isAccepted ? `Select ${asset.type} asset` : 'Not available for this format'
                      }
                      aria-pressed={selected}
                      className={[
                        'socials-composer__asset',
                        selected && 'socials-composer__asset--selected',
                        !isAccepted && 'socials-composer__asset--disabled',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      disabled={!isAccepted}
                      key={asset.url}
                      onClick={() => isAccepted && toggleMedia(asset.url)}
                      title={isAccepted ? undefined : 'Not available for this format'}
                      type="button"
                    >
                      {asset.type === 'image' ? (
                        <img alt={asset.altText ?? ''} src={asset.url} />
                      ) : (
                        <>
                          <video
                            aria-label="Video asset"
                            muted
                            preload="metadata"
                            src={asset.url}
                          />
                          <span>Video</span>
                        </>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="socials-composer__add-media">
                <Button onClick={openDrawer} size="small">
                  Media library
                </Button>
                <div className="socials-composer__add-media-url">
                  <input
                    aria-label="Media URL"
                    onChange={(event) => setUrlInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleAddByUrl()
                      }
                    }}
                    placeholder="https://..."
                    type="url"
                    value={urlInput}
                  />
                  <select
                    aria-label="URL media type"
                    onChange={(event) =>
                      setUrlTypeOverride(event.target.value as 'image' | 'video')
                    }
                    value={urlTypeOverride}
                  >
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                  </select>
                  <Button disabled={!urlInput.trim()} onClick={handleAddByUrl} size="small">
                    Add URL
                  </Button>
                </div>
              </div>
            </fieldset>
          )}

          <label>
            Schedule (optional){' '}
            <input
              aria-label="Schedule post"
              min={new Date().toISOString().slice(0, 16)}
              onChange={(event) => setScheduledAt(event.target.value)}
              type="datetime-local"
              value={scheduledAt}
            />
          </label>

          {validation?.issues.length ? (
            <ul aria-live="polite" className="socials-composer__issues">
              {validation.issues.map((issue, index) => (
                <li
                  className={`socials-composer__issue--${issue.severity}`}
                  key={`${issue.field ?? 'general'}-${index}`}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <p aria-live="polite" className="socials-composer__valid">
              Ready to publish
            </p>
          )}
          {publishedRef && (
            <p className="socials-composer__success">
              {publishedRef.meta?.scheduled ? 'Scheduled successfully.' : 'Published successfully.'}{' '}
              {publishedRef.externalUrl && (
                <a href={publishedRef.externalUrl} rel="noreferrer" target="_blank">
                  View post
                </a>
              )}
            </p>
          )}
          <Button
            disabled={loading || validation?.ok === false}
            onClick={() => {
              void publish()
            }}
          >
            {loading ? 'Publishing…' : scheduledAt ? 'Schedule post' : 'Publish now'}
          </Button>
        </div>

        <aside
          aria-label={`${PLATFORM_LABELS[platform]} preview`}
          className={`socials-composer__preview socials-composer__preview--${platform}`}
        >
          <span className="socials-composer__preview-platform">{PLATFORM_LABELS[platform]}</span>
          {getEffectiveAssets(platform, state, envelope.draft)[0]?.type === 'image' && (
            <img
              alt={state.altText}
              src={getEffectiveAssets(platform, state, envelope.draft)[0].url}
            />
          )}
          {getEffectiveAssets(platform, state, envelope.draft)[0]?.type === 'video' && (
            <video
              aria-label={state.altText || 'Selected video preview'}
              controls
              muted
              playsInline
              preload="metadata"
              src={getEffectiveAssets(platform, state, envelope.draft)[0].url}
            />
          )}
          <strong>{state.title || envelope.draft.content.title}</strong>
          <p>{state.copy}</p>
          {state.link && (platform === 'pinterest' || state.format === 'LINK') && (
            <small>{state.link}</small>
          )}
          <em>API preview - final rendering may vary by platform and device.</em>
        </aside>
      </div>

      {history.length > 0 && (
        <details className="socials-composer__history">
          <summary>
            Recent {PLATFORM_LABELS[platform]} history ({history.length})
          </summary>
          <ul>
            {history.slice(0, 5).map((row) => (
              <li key={row.id} style={{ alignItems: 'center', display: 'flex', gap: '0.5rem' }}>
                <span style={{ flex: 1 }}>
                  <span
                    style={{
                      color:
                        row.status === 'published'
                          ? 'var(--theme-success-500)'
                          : row.status === 'deleted'
                            ? 'var(--theme-elevation-400)'
                            : undefined,
                    }}
                  >
                    {row.status ?? 'unknown'}
                  </span>
                  {row.publishedAt ? ` · ${new Date(row.publishedAt).toLocaleString()}` : ''}
                  {row.externalUrl && (
                    <>
                      {' '}
                      ·{' '}
                      <a href={row.externalUrl} rel="noreferrer" target="_blank">
                        open
                      </a>
                    </>
                  )}
                </span>
                {row.status === 'published' && (
                  <span style={{ display: 'flex', gap: '0.25rem' }}>
                    {confirmingDeleteId === row.id ? (
                      <>
                        <button
                          disabled={deletingId === row.id}
                          onClick={() => {
                            if (isInstagram) {
                              void markDeletedPost(row.id)
                            } else {
                              void deletePost(row.id)
                            }
                          }}
                          style={{ color: 'var(--theme-error-500)', fontSize: '0.8rem' }}
                          type="button"
                        >
                          {isInstagram ? 'Confirm mark deleted' : 'Confirm delete'}
                        </button>
                        <button
                          onClick={() => setConfirmingDeleteId(undefined)}
                          style={{ fontSize: '0.8rem' }}
                          type="button"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={deletingId === row.id}
                        onClick={() => setConfirmingDeleteId(row.id)}
                        style={{ color: 'var(--theme-error-400)', fontSize: '0.8rem' }}
                        type="button"
                      >
                        {isInstagram ? 'Mark deleted (removed in app)' : 'Delete'}
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <ListDrawer onSelect={handleLibrarySelect as never} />
    </section>
  )
}

// ===========================================================================
// Standalone composer
// ===========================================================================

const StandaloneComposer: React.FC = () => {
  const { config } = useConfig()

  // Fix 1: read from config.admin?.custom (serialized to browser).
  const socials = asRecord(asRecord(config.admin?.custom)?.socials)

  const enabledPlatforms = Array.isArray(socials?.enabledPlatforms)
    ? socials.enabledPlatforms.filter(
        (value): value is PlatformId =>
          typeof value === 'string' && PLATFORM_IDS.includes(value as PlatformId),
      )
    : []
  const apiRoute = typeof config.routes?.api === 'string' ? config.routes.api : '/api'
  const basePath = typeof socials?.apiBasePath === 'string' ? socials.apiBasePath : '/socials'
  const endpointBase = `${apiRoute.replace(/\/$/, '')}${basePath}`

  const [state, setState] = useState<StandaloneComposerState>(() =>
    buildStandaloneInitialState(enabledPlatforms),
  )
  const [perChannelFormat, setPerChannelFormat] = useState<Partial<Record<PlatformId, string>>>({})
  const [destinations, setDestinations] = useState<Partial<Record<PlatformId, Destination[]>>>({})
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<
    Array<{
      error?: string
      ok: boolean
      platform: PlatformId
      publishedRef?: {
        externalId: string
        externalUrl?: string
        meta?: Record<string, unknown>
        platform: PlatformId
      }
    }>
  >([])

  // Fix 5 (standalone): destructure closeDrawer from the tuple.
  const [ListDrawer, , { closeDrawer, openDrawer }] = useListDrawer({
    collectionSlugs: undefined as never,
    uploads: true,
  })

  // URL input state
  const [urlInput, setUrlInput] = useState('')
  const [urlTypeOverride, setUrlTypeOverride] = useState<'image' | 'video'>('image')

  // Load destinations for selected channels
  useEffect(() => {
    const controllers: AbortController[] = []
    for (const platform of state.channels) {
      if (destinations[platform]) {
        continue
      }
      const controller = new AbortController()
      controllers.push(controller)
      void (async () => {
        try {
          const response = await fetch(`${endpointBase}${destinationPath[platform]}`, {
            signal: controller.signal,
          })
          const body = (await response.json()) as Record<string, unknown>
          if (!response.ok) {
            return
          }
          const values =
            platform === 'pinterest'
              ? body.boards
              : platform === 'facebook'
                ? body.pages
                : platform === 'instagram'
                  ? body.accounts
                  : body.locations
          const rows = Array.isArray(values)
            ? values
                .map(asRecord)
                .filter((row): row is Record<string, unknown> => row !== undefined)
            : []
          const next = rows.flatMap((row) => {
            const idValue =
              platform === 'instagram'
                ? row.igUserId
                : platform === 'gbp'
                  ? row.resourceName
                  : row.id
            if (typeof idValue !== 'string') {
              return []
            }
            const label =
              [row.name, row.pageName, row.title, row.storeCode].find(
                (value): value is string => typeof value === 'string',
              ) ?? idValue
            return [{ id: idValue, label }]
          })
          setDestinations((current) => ({ ...current, [platform]: next }))
        } catch {
          // Silently ignore on abort
        }
      })()
    }
    return () => controllers.forEach((c) => c.abort())
  }, [endpointBase, state.channels, destinations])

  const toggleChannel = (platform: PlatformId): void => {
    setState((current) => ({
      ...current,
      channels: current.channels.includes(platform)
        ? current.channels.filter((p) => p !== platform)
        : [...current.channels, platform],
    }))
  }

  // Fix 5 (standalone): call closeDrawer before processing selection.
  const handleLibrarySelect = useCallback(
    async (doc: { collectionSlug: string; docID: string }) => {
      closeDrawer()
      try {
        const response = await fetch(`${apiRoute}/${doc.collectionSlug}/${doc.docID}`)
        if (!response.ok) {
          toast.error('Failed to load media document')
          return
        }
        const mediaDoc = (await response.json()) as Record<string, unknown>
        const mimeType = typeof mediaDoc.mimeType === 'string' ? mediaDoc.mimeType : undefined
        const type = inferMediaType('', mimeType)
        const format = inferFormat('', mimeType)

        let url = typeof mediaDoc.url === 'string' ? mediaDoc.url : ''
        if (
          type === 'image' &&
          format &&
          ['avif', 'webp'].includes(format) &&
          mediaDoc.sizes &&
          typeof mediaDoc.sizes === 'object'
        ) {
          const sizes = mediaDoc.sizes as Record<string, Record<string, unknown>>
          let bestWidth = 0
          for (const [, sizeData] of Object.entries(sizes)) {
            const sizeUrl = sizeData?.url
            const sizeMime = sizeData?.mimeType
            const sizeWidth = typeof sizeData?.width === 'number' ? sizeData.width : 0
            if (
              typeof sizeUrl === 'string' &&
              typeof sizeMime === 'string' &&
              sizeMime.includes('jpeg') &&
              sizeWidth > bestWidth
            ) {
              bestWidth = sizeWidth
              url = sizeUrl
            }
          }
        }

        if (url.startsWith('/')) {
          url = `${window.location.origin}${url}`
        }

        const newAsset: SocialDraftMedia = {
          type,
          altText: typeof mediaDoc.alt === 'string' ? mediaDoc.alt : undefined,
          format,
          height: typeof mediaDoc.height === 'number' ? mediaDoc.height : undefined,
          url,
          width: typeof mediaDoc.width === 'number' ? mediaDoc.width : undefined,
        }

        setState((current) => ({ ...current, media: [...current.media, newAsset] }))
        toast.success('Media added from library')
      } catch {
        toast.error('Failed to load media from library')
      }
    },
    [apiRoute, closeDrawer],
  )

  const handleAddByUrl = useCallback(() => {
    if (!urlInput.trim()) {
      return
    }
    const url = urlInput.trim()
    const newAsset: SocialDraftMedia = {
      type: urlTypeOverride,
      format: inferFormat(url),
      url: url.startsWith('/') ? `${window.location.origin}${url}` : url,
    }
    setState((current) => ({ ...current, media: [...current.media, newAsset] }))
    setUrlInput('')
    toast.success('Media added by URL')
  }, [urlInput, urlTypeOverride])

  // Fix 3: guard compose response shape before rendering results.
  const publish = async (): Promise<void> => {
    if (!state.title.trim()) {
      toast.error('Title is required.')
      return
    }
    if (state.channels.length === 0) {
      toast.error('Select at least one channel.')
      return
    }
    setLoading(true)
    setResults([])
    try {
      const body = compileStandalonePublishBody(state, perChannelFormat)
      const response = await fetch(`${endpointBase}/compose/publish`, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const rawBody: unknown = await response.json()
      const parsed = parseComposeResponse(response.ok, rawBody)
      if (!parsed.ok) {
        toast.error(parsed.error)
        return
      }
      setResults(parsed.data.results)
      if (parsed.data.anyPublished) {
        toast.success('Published to at least one channel.')
      } else {
        toast.error('All channels failed.')
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="socials-composer">
      <header className="socials-composer__header">
        <div>
          <h2>Standalone composer</h2>
          <p>Compose one post from scratch and publish it to multiple channels at once.</p>
        </div>
      </header>

      <div className="socials-composer__fields" style={{ marginTop: '1.5rem' }}>
        <label>
          Title *
          <input
            aria-label="Post title"
            onChange={(event) => setState((s) => ({ ...s, title: event.target.value }))}
            required
            value={state.title}
          />
        </label>

        <label>
          Body
          <textarea
            aria-label="Post body"
            onChange={(event) => setState((s) => ({ ...s, body: event.target.value }))}
            rows={6}
            value={state.body}
          />
        </label>

        <label>
          Link (optional)
          <input
            aria-label="Post link"
            onChange={(event) => setState((s) => ({ ...s, link: event.target.value }))}
            type="url"
            value={state.link}
          />
        </label>

        <fieldset className="socials-composer__media">
          <legend>Media</legend>
          {state.media.length > 0 && (
            <div className="socials-composer__media-grid">
              {state.media.map((asset, index) => (
                <div
                  className="socials-composer__asset socials-composer__asset--selected"
                  key={index}
                >
                  {asset.type === 'image' ? (
                    <img alt={asset.altText ?? ''} src={asset.url} />
                  ) : (
                    <>
                      <video aria-label="Video asset" muted preload="metadata" src={asset.url} />
                      <span>Video</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="socials-composer__add-media">
            <Button onClick={openDrawer} size="small">
              Media library
            </Button>
            <div className="socials-composer__add-media-url">
              <input
                aria-label="Media URL"
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleAddByUrl()
                  }
                }}
                placeholder="https://..."
                type="url"
                value={urlInput}
              />
              <select
                aria-label="URL media type"
                onChange={(event) => setUrlTypeOverride(event.target.value as 'image' | 'video')}
                value={urlTypeOverride}
              >
                <option value="image">Image</option>
                <option value="video">Video</option>
              </select>
              <Button disabled={!urlInput.trim()} onClick={handleAddByUrl} size="small">
                Add URL
              </Button>
            </div>
          </div>
        </fieldset>

        <fieldset
          style={{ border: '1px solid var(--socials-border)', borderRadius: 6, padding: '0.75rem' }}
        >
          <legend>Channels</legend>
          <div className="socials-composer__channels">
            {enabledPlatforms.map((platform) => (
              <label
                className={[
                  'socials-composer__channel-chip',
                  state.channels.includes(platform) && 'socials-composer__channel-chip--active',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={platform}
              >
                <input
                  aria-label={PLATFORM_LABELS[platform]}
                  checked={state.channels.includes(platform)}
                  onChange={() => toggleChannel(platform)}
                  type="checkbox"
                />
                {PLATFORM_LABELS[platform]}
              </label>
            ))}
          </div>

          {state.channels.map((platform) => (
            <div key={platform} style={{ marginTop: '0.75rem' }}>
              <div className="socials-composer__row">
                <label>
                  {PLATFORM_LABELS[platform]} destination
                  <select
                    onChange={(event) =>
                      setState((s) => ({
                        ...s,
                        destinations: { ...s.destinations, [platform]: event.target.value },
                      }))
                    }
                    value={state.destinations[platform] ?? ''}
                  >
                    <option value="">Select…</option>
                    {(destinations[platform] ?? []).map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {PLATFORM_LABELS[platform]} format
                  <select
                    onChange={(event) =>
                      setPerChannelFormat((f) => ({ ...f, [platform]: event.target.value }))
                    }
                    value={perChannelFormat[platform] ?? ''}
                  >
                    <option value="">Default</option>
                    {platformFormats[platform].map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ))}
        </fieldset>

        {results.length > 0 && (
          <ul className="socials-composer__results">
            {results.map((r) => (
              <li
                className={`socials-composer__result-item ${r.ok ? 'socials-composer__result-ok' : 'socials-composer__result-err'}`}
                key={r.platform}
              >
                <strong>{PLATFORM_LABELS[r.platform]}</strong>
                {r.ok ? (
                  <span className="socials-composer__success">
                    Published
                    {r.publishedRef?.externalUrl && (
                      <>
                        {' '}
                        <a href={r.publishedRef.externalUrl} rel="noreferrer" target="_blank">
                          View
                        </a>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="socials-composer__error">{r.error ?? 'Failed'}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <Button
          disabled={loading || state.channels.length === 0 || !state.title.trim()}
          onClick={() => {
            void publish()
          }}
        >
          {loading ? 'Publishing…' : 'Publish to selected channels'}
        </Button>
      </div>

      <ListDrawer onSelect={handleLibrarySelect as never} />
    </section>
  )
}

// ===========================================================================
// Entry point
// ===========================================================================

export const SocialPublishPanelClient: React.FC<Props> = ({
  mode = 'source',
  sourceKind = 'product',
}) => {
  if (mode === 'standalone') {
    return <StandaloneComposer />
  }
  return <SourceComposer sourceKind={sourceKind} />
}
