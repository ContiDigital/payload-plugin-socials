'use client'

import { Button, toast, useConfig, useDocumentInfo, useListDrawer } from '@payloadcms/ui'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import { resolveSocialsEndpointBase } from './accessModel.js'
import {
  acceptedMediaTypes,
  buildInitialComposerState,
  compileComposerInput,
  type ComposerState,
  filterTemplatesForContext,
  formatLocalDateTimeMin,
  getEffectiveAssets,
  mergeDraftMedia,
  normalizeSelectedUploadMedia,
  pickDefaultTemplate,
  pruneSelectedMedia,
  reorderSelectedMedia,
  shouldFetchEnvelope,
  supportsMultipleMedia,
} from './socialComposerModel.js'
import {
  asRecord,
  type ComposerDestination,
  destinationPath,
  inferMediaFormat,
  platformFormats,
} from './socialComposerViewModel.js'
import { VideoPreviewPane, VideoTile } from './SocialMediaPreview.js'
import { StandaloneSocialComposer } from './StandaloneSocialComposer.js'
import { useSocialsAccess } from './useSocialsAccess.js'
import './SocialPublishPanelClient.scss'

type Props = {
  mode?: 'source' | 'standalone'
  sourceKind?: string
}
type Destination = ComposerDestination
type HistoryRow = {
  externalUrl?: string
  id: number | string
  publishedAt?: string
  scheduledAt?: null | string
  status?: string
}
type ResolvedTemplate = {
  appliesTo: PlatformId[]
  description?: string
  id: number | string
  isDefault?: boolean
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
  sourceKind?: string
}
type PreviewEnvelope = {
  capabilities: PlatformCapabilities
  draft: SocialDraft
  error?: string
  preview: PreviewResult
}

// ===========================================================================
// Source-mode composer (existing behavior, overhauled)
// ===========================================================================

const SourceComposerAuthorized: React.FC<{ sourceKind: string }> = ({ sourceKind }) => {
  const { id } = useDocumentInfo()
  const { config } = useConfig()

  // Payload serializes plugin client configuration under admin.custom.
  const socials = asRecord(asRecord(config.admin?.custom)?.socials)

  const enabledPlatforms = Array.isArray(socials?.enabledPlatforms)
    ? socials.enabledPlatforms.filter(
        (value): value is PlatformId =>
          typeof value === 'string' && PLATFORM_IDS.includes(value as PlatformId),
      )
    : []
  const [platform, setPlatform] = useState<PlatformId>(enabledPlatforms[0] ?? 'pinterest')
  const [envelopes, setEnvelopes] = useState<Partial<Record<PlatformId, PreviewEnvelope>>>({})
  const envelopesRef = useRef(envelopes)
  const [states, setStates] = useState<Partial<Record<PlatformId, ComposerState>>>({})
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [templates, setTemplates] = useState<ResolvedTemplate[]>([])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  // Platforms whose default template has already been auto-applied. Kept in a
  // ref so re-applying does not fight an operator who switched back to
  // "Platform defaults": the default is offered once per platform, not on every
  // render where no template is selected.
  const autoAppliedRef = useRef<Set<PlatformId>>(new Set())
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [scheduledAt, setScheduledAt] = useState('')
  const [validation, setValidation] = useState<ValidationResult>()
  const [publishedRef, setPublishedRef] = useState<PublishedRef>()
  const [loading, setLoading] = useState(false)
  // Two-step delete/cancel/mark-deleted confirm: stores the post id that is armed.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | string>()
  const [deletingId, setDeletingId] = useState<number | string>()
  // The media pool is shared while selection and ordering remain per platform.
  const [extraMedia, setExtraMedia] = useState<SocialDraftMedia[]>([])

  const [ListDrawer, , { closeDrawer, openDrawer }] = useListDrawer({
    collectionSlugs: undefined as never,
    uploads: true,
  })

  // URL input state
  const [urlInput, setUrlInput] = useState('')
  const [urlTypeOverride, setUrlTypeOverride] = useState<'image' | 'video'>('image')
  const [dragFrom, setDragFrom] = useState<null | number>(null)

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
  // Resolver and operator media remain separate so cached previews are immutable.
  const mergedDraft = useMemo(
    () =>
      envelope
        ? { ...envelope.draft, media: mergeDraftMedia(envelope.draft.media, extraMedia) }
        : undefined,
    [envelope, extraMedia],
  )
  const input = useMemo(
    () => (state && mergedDraft ? compileComposerInput(platform, state, mergedDraft) : undefined),
    [mergedDraft, platform, state],
  )

  useEffect(() => {
    envelopesRef.current = envelopes
  }, [envelopes])

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
          mergeDraftMedia(draft.media, extraMedia),
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
    [envelopes, extraMedia, platform],
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

  // Cache previews per platform so tab switches preserve operator state.
  useEffect(() => {
    if (!id) {
      return
    }
    if (!shouldFetchEnvelope(envelopesRef.current, platform)) {
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
  }, [id, platform, sourceBase])

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
          setTemplatesLoaded(true)
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

  const applyTemplate = useCallback(
    (templateId: string): void => {
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
    },
    [platform, state?.altText, state?.copy, state?.title, templates, updateState],
  )

  // Auto-apply the default template for a platform the first time its composer
  // state is ready. Runs once per platform (autoAppliedRef guard) so switching
  // back to "Platform defaults" is not immediately overridden.
  useEffect(() => {
    if (!templatesLoaded) {
      return
    }
    if (!states[platform]) {
      return
    }
    if (autoAppliedRef.current.has(platform)) {
      return
    }
    autoAppliedRef.current.add(platform)
    const preferred = pickDefaultTemplate(
      filterTemplatesForContext(templates, sourceKind, platform),
    )
    if (preferred) {
      applyTemplate(String(preferred.id))
    }
  }, [applyTemplate, platform, sourceKind, states, templates, templatesLoaded])

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

  // Payload's ListDrawer does not close itself after selection.
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
        const newAsset = normalizeSelectedUploadMedia(mediaDoc, {
          apiRoute,
          collectionSlug: doc.collectionSlug,
          origin: window.location.origin,
        })
        if (!newAsset) {
          toast.error('Selected media has no usable file URL')
          return
        }
        setExtraMedia((current) => mergeDraftMedia(current, [newAsset]))
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
      format: inferMediaFormat(url),
      url: url.startsWith('/') ? `${window.location.origin}${url}` : url,
    }
    setExtraMedia((current) => mergeDraftMedia(current, [newAsset]))
    setUrlInput('')
    toast.success('Media added by URL')
  }, [urlInput, urlTypeOverride])

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

  /** Cancel a queued row without an upstream mutation. */
  const cancelPost = async (postId: number | string): Promise<void> => {
    setDeletingId(postId)
    setConfirmingDeleteId(undefined)
    try {
      const response = await fetch(`${endpointBase}/posts/${encodeURIComponent(String(postId))}`, {
        method: 'DELETE',
      })
      const result = (await response.json()) as { error?: string; ok?: boolean; status?: string }
      if (!response.ok) {
        throw new Error(result.error ?? `Cancel failed (${response.status})`)
      }
      toast.success('Scheduled post cancelled.')
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
  if (!state || !envelope || !mergedDraft) {
    return (
      <section aria-busy="true" className="socials-composer">
        Loading social composer…
      </section>
    )
  }

  const filteredTemplates = filterTemplatesForContext(templates, sourceKind, platform)
  const assets = mergedDraft.media
  const accepted = acceptedMediaTypes(platform, state.format)
  const isMultiMedia = supportsMultipleMedia(platform, state.format)
  const moveSelected = (from: number, to: number): void => {
    updateState({ selectedMedia: reorderSelectedMedia(state.selectedMedia, from, to) })
  }
  // In multi mode the grid lists selected assets first (in publish order) so the
  // 1-based badges read contiguously and drag/arrow moves feel natural.
  const orderedAssets = isMultiMedia
    ? [
        ...state.selectedMedia.flatMap((url) => {
          const found = assets.find((asset) => asset.url === url)
          return found ? [found] : []
        }),
        ...assets.filter((asset) => !state.selectedMedia.includes(asset.url)),
      ]
    : assets
  const previewAsset = getEffectiveAssets(platform, state, mergedDraft)[0]
  const mediaRequired =
    state.format !== 'LINK' && state.format !== 'STANDARD' && state.format !== 'ALERT'
  const copyLimit = envelope.capabilities.limits.captionMaxChars

  // Whether the active platform uses the localOnly reconcile path instead of a
  // live upstream delete. Instagram posts cannot be removed via the API.
  const isInstagram = platform === 'instagram'

  // datetime-local values must use local fields rather than an ISO UTC wall clock.
  const scheduleMin = formatLocalDateTimeMin(new Date())

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
              <div className="socials-composer__media-grid" role="list">
                {orderedAssets.map((asset) => {
                  const orderIndex = state.selectedMedia.indexOf(asset.url)
                  const selected = orderIndex >= 0
                  const isAccepted = accepted.includes(asset.type)
                  const reorderable = isMultiMedia && selected
                  return (
                    // Drag reorder is a progressive enhancement; the per-tile
                    // arrow buttons provide the keyboard/touch-accessible path.
                    <div
                      className={[
                        'socials-composer__asset',
                        selected && 'socials-composer__asset--selected',
                        !isAccepted && 'socials-composer__asset--disabled',
                        reorderable && 'socials-composer__asset--draggable',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      draggable={reorderable}
                      key={asset.url}
                      onDragEnd={() => setDragFrom(null)}
                      onDragOver={reorderable ? (event) => event.preventDefault() : undefined}
                      onDragStart={
                        reorderable
                          ? (event) => {
                              setDragFrom(orderIndex)
                              event.dataTransfer.effectAllowed = 'move'
                            }
                          : undefined
                      }
                      onDrop={
                        reorderable
                          ? (event) => {
                              event.preventDefault()
                              if (dragFrom !== null) {
                                moveSelected(dragFrom, orderIndex)
                              }
                              setDragFrom(null)
                            }
                          : undefined
                      }
                      role="listitem"
                    >
                      {asset.type === 'image' ? (
                        <img alt={asset.altText ?? ''} src={asset.url} />
                      ) : (
                        <VideoTile asset={asset} />
                      )}
                      <button
                        aria-label={
                          isAccepted
                            ? `${selected ? 'Deselect' : 'Select'} ${asset.type} asset`
                            : 'Not available for this format'
                        }
                        aria-pressed={selected}
                        className="socials-composer__asset-toggle"
                        disabled={!isAccepted}
                        onClick={() => isAccepted && toggleMedia(asset.url)}
                        title={isAccepted ? undefined : 'Not available for this format'}
                        type="button"
                      />
                      {reorderable && (
                        <span className="socials-composer__asset-order">{orderIndex + 1}</span>
                      )}
                      {reorderable && (
                        <div className="socials-composer__asset-arrows">
                          <button
                            aria-label="Move media earlier"
                            disabled={orderIndex <= 0}
                            onClick={() => moveSelected(orderIndex, orderIndex - 1)}
                            type="button"
                          >
                            ‹
                          </button>
                          <button
                            aria-label="Move media later"
                            disabled={orderIndex >= state.selectedMedia.length - 1}
                            onClick={() => moveSelected(orderIndex, orderIndex + 1)}
                            type="button"
                          >
                            ›
                          </button>
                        </div>
                      )}
                    </div>
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
              min={scheduleMin}
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
          {previewAsset?.type === 'image' && <img alt={state.altText} src={previewAsset.url} />}
          {previewAsset?.type === 'video' && (
            <VideoPreviewPane
              asset={previewAsset}
              label={state.altText || 'Selected video preview'}
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
                            : row.status === 'queued'
                              ? 'var(--theme-warning-500)'
                              : row.status === 'cancelled'
                                ? 'var(--theme-elevation-400)'
                                : undefined,
                    }}
                  >
                    {row.status ?? 'unknown'}
                  </span>
                  {row.status === 'queued' && row.scheduledAt
                    ? ` · scheduled for ${new Date(row.scheduledAt).toLocaleString()}`
                    : row.publishedAt
                      ? ` · ${new Date(row.publishedAt).toLocaleString()}`
                      : ''}
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
                {/* Published rows: delete / mark-deleted action */}
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
                {row.status === 'queued' && (
                  <span style={{ display: 'flex', gap: '0.25rem' }}>
                    {confirmingDeleteId === row.id ? (
                      <>
                        <button
                          disabled={deletingId === row.id}
                          onClick={() => void cancelPost(row.id)}
                          style={{ color: 'var(--theme-error-500)', fontSize: '0.8rem' }}
                          type="button"
                        >
                          Confirm cancel
                        </button>
                        <button
                          onClick={() => setConfirmingDeleteId(undefined)}
                          style={{ fontSize: '0.8rem' }}
                          type="button"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={deletingId === row.id}
                        onClick={() => setConfirmingDeleteId(row.id)}
                        style={{ color: 'var(--theme-error-400)', fontSize: '0.8rem' }}
                        type="button"
                      >
                        Cancel
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

/**
 * Visibility gate for the source-mode composer. Probes `{basePath}/access` once
 * and mounts the composer only for a `publisher`. Everyone else gets an empty
 * panel body (the injected Socials tab shows nothing) with no fetches and no
 * toasts. Mounting the authorized composer only when allowed also means its
 * preview/history/destination fetches never fire for an unauthorized user.
 */
const SourceComposer: React.FC<{ sourceKind: string }> = ({ sourceKind }) => {
  const { config } = useConfig()
  const { loading, publisher } = useSocialsAccess(resolveSocialsEndpointBase(config))
  if (loading || !publisher) {
    return null
  }
  return <SourceComposerAuthorized sourceKind={sourceKind} />
}

// ===========================================================================
// Entry point
// ===========================================================================

export const SocialPublishPanelClient: React.FC<Props> = ({
  mode = 'source',
  sourceKind = 'product',
}) => {
  if (mode === 'standalone') {
    return <StandaloneSocialComposer />
  }
  return <SourceComposer sourceKind={sourceKind} />
}
