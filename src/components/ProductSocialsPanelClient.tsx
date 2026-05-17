'use client'

import { Button, useConfig, useDocumentInfo } from '@payloadcms/ui'
import React, { useEffect, useMemo, useState } from 'react'

import type { PlatformId } from '../constants.js'
import type {
  PlatformCapabilities,
  PreviewResult,
  PublishedRef,
  SocialDraft,
  ValidationResult,
} from '../types/index.js'

import { PLATFORM_IDS, PLATFORM_LABELS } from '../constants.js'
import {
  buildInitialComposerState,
  compileComposerInput,
  type ComposerState,
  getSelectedAssets,
  supportsMultipleMedia,
} from './socialComposerModel.js'
import './SocialPublishPanelClient.scss'

type Props = { sourceKind?: string }
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

export const SocialPublishPanelClient: React.FC<Props> = ({ sourceKind = 'product' }) => {
  const { id } = useDocumentInfo()
  const { config } = useConfig()
  const socials = asRecord(asRecord(config.custom)?.socials)
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
  const [error, setError] = useState<string>()
  const [publishedRef, setPublishedRef] = useState<PublishedRef>()
  const [loading, setLoading] = useState(false)

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

  const updateState = (patch: Partial<ComposerState>): void => {
    setStates((current) => {
      const existing = current[platform]
      return existing ? { ...current, [platform]: { ...existing, ...patch } } : current
    })
  }

  useEffect(() => {
    if (!id) {
      return
    }
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setError(undefined)
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
          setError(caught instanceof Error ? caught.message : String(caught))
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
          setError(caught instanceof Error ? caught.message : String(caught))
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

  const publish = async (): Promise<void> => {
    if (!input) {
      return
    }
    if (validation && !validation.ok) {
      setError('Resolve the validation errors before publishing.')
      return
    }
    setLoading(true)
    setError(undefined)
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
      setPublishedRef(
        result.publishedRef ?? { externalId: '', meta: { scheduled: true }, platform },
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
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
  const mediaRequired =
    state.format !== 'LINK' && state.format !== 'STANDARD' && state.format !== 'ALERT'
  const copyLimit = envelope.capabilities.limits.captionMaxChars

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
                onChange={(event) => updateState({ format: event.target.value })}
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
                {supportsMultipleMedia(platform, state.format) ? '(choose and order 2–10)' : ''}
              </legend>
              {assets.length === 0 && <p>No source media is available.</p>}
              <div className="socials-composer__media-grid">
                {assets.map((asset) => {
                  const selected = state.selectedMedia.includes(asset.url)
                  return (
                    <button
                      aria-label={`Select ${asset.type} asset`}
                      aria-pressed={selected}
                      className={
                        selected
                          ? 'socials-composer__asset socials-composer__asset--selected'
                          : 'socials-composer__asset'
                      }
                      key={asset.url}
                      onClick={() => toggleMedia(asset.url)}
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
          {error && (
            <p className="socials-composer__error" role="alert">
              {error}
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
          {getSelectedAssets(state, envelope.draft)[0]?.type === 'image' && (
            <img alt={state.altText} src={getSelectedAssets(state, envelope.draft)[0].url} />
          )}
          <strong>{platform === 'pinterest' ? state.title : envelope.draft.content.title}</strong>
          <p>{state.copy}</p>
          {state.link && (platform === 'pinterest' || state.format === 'LINK') && (
            <small>{state.link}</small>
          )}
          <em>API preview — final rendering may vary by platform and device.</em>
        </aside>
      </div>

      {history.length > 0 && (
        <details className="socials-composer__history">
          <summary>
            Recent {PLATFORM_LABELS[platform]} history ({history.length})
          </summary>
          <ul>
            {history.slice(0, 5).map((row) => (
              <li key={row.id}>
                {row.status ?? 'unknown'}
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
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
