import Joi from 'joi'
import { coveragePercentage } from '../color-formatters.js'
import { BaseSvgScrapingService, pathParam, queryParam } from '../index.js'
import { parseJson } from '../../core/base-service/json.js'

// https://docs.codecov.io/reference#totals
// A new repository that's been added but never had any coverage reports
// uploaded will not have a `commit` object in the response and sometimes
// the `totals` object can also be missing for the latest commit.
// Accordingly the schema is a bit relaxed to support those scenarios
// and then they are handled in the transform and render functions.
const legacySchema = Joi.object({
  commit: Joi.object({
    totals: Joi.object({
      c: Joi.number().required(),
    }),
  }),
}).required()

const queryParamSchema = Joi.object({
  token: Joi.string(),
  // https://docs.codecov.io/docs/flags
  // Flags Must consist only of alphanumeric characters, '_', '-', or '.'
  // and not exceed 45 characters.
  flag: Joi.string().regex(/^[\w.-]{1,45}$/),
}).required()

const schema = Joi.object({
  message: Joi.string()
    .regex(/^\d{1,3}%|unknown$/)
    .required(),
})

const svgValueMatcher = />(\d{1,3}%|unknown)<\/text><\/g>/

const badgeTokenPattern = /^\w{10}$/

const description = `
You may specify a Codecov badge token to get coverage for a private repository.

You can find the token under the badge section of your project settings page, in this url: <code>https://codecov.io/[vcsName]/[user]/[repo]/config/badge</code>.
`

export default class Codecov extends BaseSvgScrapingService {
  static category = 'coverage'
  static route = {
    base: 'codecov/c',
    // https://docs.codecov.io/docs#section-common-questions
    // Github, BitBucket, and GitLab are the only supported options (long or short form)
    pattern: ':vcsName(github|gh|bitbucket|bb|gl|gitlab)/:user/:repo/:branch*',
    queryParamSchema,
  }

  static openApi = {
    '/codecov/c/{vcsName}/{user}/{repo}': {
      get: {
        summary: 'Codecov',
        description,
        parameters: [
          pathParam({
            name: 'vcsName',
            example: 'github',
            schema: { type: 'string', enum: this.getEnum('vcsName') },
          }),
          pathParam({ name: 'user', example: 'codecov' }),
          pathParam({ name: 'repo', example: 'example-node' }),
          queryParam({ name: 'token', example: 'a1b2c3d4e5' }),
          queryParam({ name: 'flag', example: 'flag_name' }),
        ],
      },
    },
    '/codecov/c/{vcsName}/{user}/{repo}/{branch}': {
      get: {
        summary: 'Codecov (with branch)',
        description,
        parameters: [
          pathParam({
            name: 'vcsName',
            example: 'github',
            schema: { type: 'string', enum: this.getEnum('vcsName') },
          }),
          pathParam({ name: 'user', example: 'codecov' }),
          pathParam({ name: 'repo', example: 'example-node' }),
          pathParam({ name: 'branch', example: 'master' }),
          queryParam({ name: 'token', example: 'a1b2c3d4e5' }),
          queryParam({ name: 'flag', example: 'flag_name' }),
        ],
      },
    },
  }

  static defaultBadgeData = { label: 'coverage' }

  static render({ coverage }) {
    if (coverage === 'unknown') {
      return {
        message: coverage,
        color: 'lightgrey',
      }
    }
    return {
      message: `${coverage.toFixed(0)}%`,
      color: coveragePercentage(coverage),
    }
  }

  // Here for backward-compatibility purpose.
  async legacyFetch({ vcsName, user, repo, branch, token }) {
    // Codecov Docs: https://docs.codecov.io/reference#section-get-a-single-repository
    const url = `https://codecov.io/api/${vcsName}/${user}/${repo}${
      branch ? `/branch/${branch}` : ''
    }`
    const { buffer } = await this._request({
      url,
      options: {
        headers: {
          Accept: 'application/json',
          Authorization: `token ${token}`,
        },
      },
      httpErrors: {
        401: 'not authorized to access repository',
        404: 'repository not found',
      },
    })
    const json = parseJson(buffer)
    return this.constructor._validate(json, legacySchema)
  }

  // Here for backward-compatibility purpose.
  legacyTransform({ json }) {
    if (!json.commit || !json.commit.totals) {
      return { coverage: 'unknown' }
    }

    return { coverage: +json.commit.totals.c }
  }

  // Doesn't support `flag` feature. Here for backward-compatibility purpose.
  async legacyHandle({ vcsName, user, repo, branch }, { token }) {
    const json = await this.legacyFetch({ vcsName, user, repo, branch, token })
    const { coverage } = this.legacyTransform({ json })
    return this.constructor.render({ coverage })
  }

  async fetch({ vcsName, user, repo, branch, token, flag }) {
    const url = `https://codecov.io/${vcsName}/${user}/${repo}${
      branch ? `/branch/${branch}` : ''
    }/graph/badge.svg`
    return this._requestSvg({
      schema,
      valueMatcher: svgValueMatcher,
      url,
      options: {
        searchParams: { token, flag },
      },
      httpErrors: token ? { 400: 'invalid token pattern' } : {},
    })
  }

  transform({ data }) {
    // data extracted from svg. e.g.: 42% / unknown
    let coverage = data.message || 'unknown'
    if (coverage.slice(-1) === '%') {
      // remove the trailing %
      coverage = Number(coverage.slice(0, -1))
    }
    return { coverage }
  }

  async handle({ vcsName, user, repo, branch }, { token, flag }) {
    if (!flag && token && !badgeTokenPattern.test(token)) {
      return this.legacyHandle({ vcsName, user, repo, branch }, { token })
    }

    const data = await this.fetch({ vcsName, user, repo, branch, token, flag })
    const { coverage } = this.transform({ data })
    return this.constructor.render({ coverage })
  }
}
