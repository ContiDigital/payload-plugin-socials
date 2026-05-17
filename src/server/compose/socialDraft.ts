import type { SocialDraft, SocialSourceContext } from '../../types/index.js'

import { SOCIAL_DRAFT_VERSION } from '../../constants.js'

export const buildSocialDraft = (ctx: SocialSourceContext): SocialDraft => ({
  content: {
    body: ctx.baseDescription,
    link: ctx.link,
    title: ctx.baseTitle,
  },
  media: [
    ...ctx.images.map((image) => ({
      type: 'image' as const,
      altText: image.alt,
      height: image.height,
      role: image.role,
      url: image.url,
      width: image.width,
    })),
    ...(ctx.videos ?? []).map((video) => ({
      type: 'video' as const,
      coverImageUrl: video.coverImageUrl,
      durationSeconds: video.durationSeconds,
      height: video.height,
      url: video.url,
      width: video.width,
    })),
  ],
  source: { id: ctx.sourceId, kind: ctx.sourceKind },
  version: SOCIAL_DRAFT_VERSION,
})
