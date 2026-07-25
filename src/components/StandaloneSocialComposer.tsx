'use client'

import { Button, toast, useConfig, useListDrawer } from '@payloadcms/ui'
import React, { useCallback, useEffect, useState } from 'react'

import type { PlatformId } from '../constants.js'
import type { SocialDraftMedia } from '../types/index.js'

import { PLATFORM_IDS, PLATFORM_LABELS } from '../constants.js'
import { resolveSocialsEndpointBase } from './accessModel.js'
import {
  buildStandaloneInitialState,
  compileStandalonePublishBody,
  mergeDraftMedia,
  normalizeSelectedUploadMedia,
  parseComposeResponse,
  reorderSelectedMedia,
  type StandaloneComposerState,
  supportsMultipleMedia,
} from './socialComposerModel.js'
import {
  asRecord,
  type ComposerDestination,
  destinationPath,
  inferMediaFormat,
  platformFormats,
} from './socialComposerViewModel.js'
import { VideoTile } from './SocialMediaPreview.js'
import { useSocialsAccess } from './useSocialsAccess.js'
import './SocialPublishPanelClient.scss'

type Destination = ComposerDestination

const StandaloneComposerAuthorized: React.FC = () => {
  const { config } = useConfig()

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

  const [ListDrawer, , { closeDrawer, openDrawer }] = useListDrawer({
    collectionSlugs: undefined as never,
    uploads: true,
  })

  // URL input state
  const [urlInput, setUrlInput] = useState('')
  const [urlTypeOverride, setUrlTypeOverride] = useState<'image' | 'video'>('image')
  const [dragFrom, setDragFrom] = useState<null | number>(null)

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
        setState((current) => ({ ...current, media: mergeDraftMedia(current.media, [newAsset]) }))
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
    setState((current) => ({ ...current, media: mergeDraftMedia(current.media, [newAsset]) }))
    setUrlInput('')
    toast.success('Media added by URL')
  }, [urlInput, urlTypeOverride])

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

  // Media order is the provider order for carousel and multi-photo targets.
  const mediaReorderable = state.channels.some((platform) =>
    supportsMultipleMedia(platform, perChannelFormat[platform] ?? ''),
  )
  const moveMedia = (from: number, to: number): void => {
    setState((current) => {
      const urls = current.media.map((asset) => asset.url)
      const reordered = reorderSelectedMedia(urls, from, to)
      if (reordered === urls) {
        return current
      }
      const byUrl = new Map(current.media.map((asset) => [asset.url, asset]))
      return {
        ...current,
        media: reordered.flatMap((url) => {
          const asset = byUrl.get(url)
          return asset ? [asset] : []
        }),
      }
    })
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
          <legend>Media {mediaReorderable ? '(drag to order 2-10)' : ''}</legend>
          {state.media.length > 0 && (
            <div className="socials-composer__media-grid" role="list">
              {state.media.map((asset, index) => (
                // Drag reorder is a progressive enhancement; the per-tile arrow
                // buttons provide the keyboard/touch-accessible path.
                <div
                  className={[
                    'socials-composer__asset',
                    'socials-composer__asset--selected',
                    mediaReorderable && 'socials-composer__asset--draggable',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={mediaReorderable}
                  key={asset.url}
                  onDragEnd={() => setDragFrom(null)}
                  onDragOver={mediaReorderable ? (event) => event.preventDefault() : undefined}
                  onDragStart={
                    mediaReorderable
                      ? (event) => {
                          setDragFrom(index)
                          event.dataTransfer.effectAllowed = 'move'
                        }
                      : undefined
                  }
                  onDrop={
                    mediaReorderable
                      ? (event) => {
                          event.preventDefault()
                          if (dragFrom !== null) {
                            moveMedia(dragFrom, index)
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
                  {mediaReorderable && (
                    <span className="socials-composer__asset-order">{index + 1}</span>
                  )}
                  {mediaReorderable && (
                    <div className="socials-composer__asset-arrows">
                      <button
                        aria-label="Move media earlier"
                        disabled={index <= 0}
                        onClick={() => moveMedia(index, index - 1)}
                        type="button"
                      >
                        ‹
                      </button>
                      <button
                        aria-label="Move media later"
                        disabled={index >= state.media.length - 1}
                        onClick={() => moveMedia(index, index + 1)}
                        type="button"
                      >
                        ›
                      </button>
                    </div>
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

/**
 * Visibility gate for the standalone composer. Same contract as the source-mode
 * gate: probe once, render nothing until allowed, mount the composer only for a
 * `publisher`.
 */
export const StandaloneSocialComposer: React.FC = () => {
  const { config } = useConfig()
  const { loading, publisher } = useSocialsAccess(resolveSocialsEndpointBase(config))
  if (loading || !publisher) {
    return null
  }
  return <StandaloneComposerAuthorized />
}
