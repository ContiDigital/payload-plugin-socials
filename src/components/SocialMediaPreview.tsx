'use client'

import React, { useEffect, useState } from 'react'

import type { SocialDraftMedia } from '../types/index.js'

import { filenameFromUrl } from './socialComposerModel.js'

const VideoGlyph: React.FC = () => (
  <svg
    aria-hidden="true"
    className="socials-composer__video-glyph"
    fill="none"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect height="16" rx="3" stroke="currentColor" strokeWidth="1.6" width="20" x="2" y="4" />
    <path d="M10 9l5 3-5 3V9z" fill="currentColor" />
  </svg>
)

const VideoPlaceholderBody: React.FC<{ asset: SocialDraftMedia }> = ({ asset }) =>
  asset.posterUrl ? (
    <img alt={asset.altText ?? ''} src={asset.posterUrl} />
  ) : (
    <div className="socials-composer__video-placeholder">
      <VideoGlyph />
      <span className="socials-composer__video-filename">{filenameFromUrl(asset.url)}</span>
    </div>
  )

export const VideoTile: React.FC<{ asset: SocialDraftMedia }> = ({ asset }) => (
  <>
    <VideoPlaceholderBody asset={asset} />
    <span className="socials-composer__asset-kind">Video</span>
  </>
)

export const VideoPreviewPane: React.FC<{ asset: SocialDraftMedia; label: string }> = ({
  asset,
  label,
}) => {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setLoaded(false)
  }, [asset.url])
  if (loaded) {
    return (
      <video aria-label={label} controls muted playsInline preload="metadata" src={asset.url} />
    )
  }
  return (
    <div className="socials-composer__video-loadable">
      <VideoPlaceholderBody asset={asset} />
      <button
        className="socials-composer__video-load"
        onClick={() => setLoaded(true)}
        type="button"
      >
        Load video preview
      </button>
    </div>
  )
}
