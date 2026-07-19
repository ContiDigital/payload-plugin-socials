import type { SocialSourceContext } from 'payload-plugin-socials'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { payloadPluginSocials } from 'payload-plugin-socials'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000'
const hasMetaCredentials = Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET)
const hasGbpCredentials = Boolean(process.env.GBP_CLIENT_ID && process.env.GBP_CLIENT_SECRET)
const testImageUrl = process.env.SOCIALS_TEST_IMAGE_URL || 'https://example.com/dev/main.jpg'
const testLinkUrl = process.env.SOCIALS_TEST_LINK_URL || 'https://example.com/products/dev'
const testVideoUrl = process.env.SOCIALS_TEST_VIDEO_URL

// A minimal source resolver for the dev harness. Real hosts map their own
// collections (products, blog posts, projects) onto a SocialSourceContext.
const productResolver = (args: { id: number | string }): Promise<SocialSourceContext> =>
  Promise.resolve({
    baseDescription: 'A hand-carved marble lion from the dev catalog.',
    baseTitle: `Product ${args.id}`,
    images: [{ alt: 'A hand-carved marble lion.', role: 'main', url: testImageUrl }],
    link: testLinkUrl,
    metadata: { categoryLabel: 'Statues', googleMaterial: 'marble' },
    sourceId: String(args.id),
    sourceKind: 'product',
    videos: testVideoUrl ? [{ coverImageUrl: testImageUrl, url: testVideoUrl }] : undefined,
  })

export default buildConfig({
  admin: {
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    {
      slug: 'products',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'description', type: 'textarea' },
      ],
    },
    {
      slug: 'media',
      fields: [],
      upload: {
        staticDir: path.resolve(dirname, 'media'),
      },
    },
  ],
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URI || 'file:./dev/dev-database.db' },
    push: true,
  }),
  editor: lexicalEditor(),
  email: testEmailAdapter,
  onInit: async (payload) => {
    await seed(payload)
  },
  plugins: [
    payloadPluginSocials({
      assets: {
        autoConvert: true,
        renditionCollection: 'media',
      },
      authorize: () => Promise.resolve(true),
      encryptionKey:
        process.env.SOCIALS_ENCRYPTION_KEY ||
        '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      platforms: {
        ...(hasMetaCredentials
          ? {
              facebook: {
                apiVersion: process.env.META_API_VERSION || 'v25.0',
                appId: process.env.META_APP_ID,
                appSecret: process.env.META_APP_SECRET,
                enabled: true,
                redirectUri: `${publicUrl}/api/socials/facebook/oauth/callback`,
                systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN,
              },
              instagram: {
                apiVersion: process.env.META_API_VERSION || 'v25.0',
                appId: process.env.META_APP_ID,
                appSecret: process.env.META_APP_SECRET,
                enabled: true,
                redirectUri: `${publicUrl}/api/socials/instagram/oauth/callback`,
                systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN,
              },
            }
          : {}),
        ...(hasGbpCredentials
          ? {
              gbp: {
                clientId: process.env.GBP_CLIENT_ID,
                clientSecret: process.env.GBP_CLIENT_SECRET,
                enabled: true,
                redirectUri: `${publicUrl}/api/socials/gbp/oauth/callback`,
              },
            }
          : {}),
        pinterest: {
          clientId: 'dev-client-id',
          clientSecret: 'dev-client-secret',
          enabled: true,
          redirectUri: 'http://localhost:3000/api/socials/pinterest/oauth/callback',
        },
      },
      sources: {
        product: productResolver,
      },
      admin: {
        injectInto: [{ collection: 'products', sourceKind: 'product' }],
      },
      scheduling: process.env.SOCIALS_INTERNAL_API_KEY
        ? { internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY }
        : undefined,
      webhooks: process.env.META_WEBHOOK_VERIFY_TOKEN
        ? { meta: { verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN } }
        : undefined,
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'dev-secret_key',
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
