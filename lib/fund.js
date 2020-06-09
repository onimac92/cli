'use strict'

const archy = require('archy')
const Arborist = require('@npmcli/arborist')
const semver = require('semver')
const npa = require('npm-package-arg')
const { depth } = require('treeverse')
const {
  read,
  normalizeFunding,
  isValidFunding
} = require('libnpmfund')

const npm = require('./npm.js')
const output = require('./utils/output.js')
const openUrl = require('./utils/open-url.js')
const usageUtil = require('./utils/usage.js')

const usage = usageUtil(
  'fund',
  'npm fund',
  'npm fund [--json] [--browser] [--unicode] [[<@scope>/]<pkg> [--which=<fundingSourceNumber>]'
)

const completion = (opts, cb) => {
  const argv = opts.conf.argv.remain
  switch (argv[2]) {
    case 'fund':
      return cb(null, [])
    default:
      return cb(new Error(argv[2] + ' not recognized'))
  }
}

const cmd = (args, cb) => fund(args).then(() => cb()).catch(cb)

function printJSON (fundingInfo) {
  return JSON.stringify(fundingInfo, null, 2)
}

const getPrintableName = ({ name, version }) => {
  const printableVersion = version ? `@${version}` : ''
  return `${name}${printableVersion}`
}

function printHuman (fundingInfo, opts) {
  const seenUrls = new Map()

  const tree = obj =>
    archy(obj, '', { unicode: opts.unicode })

  const result = depth({
    tree: fundingInfo,
    visit: ({ name, version, funding }) => {
      // composes human readable package name
      // and creates a new archy item for readable output
      const { url } = funding || {}
      const pkgRef = getPrintableName({ name, version })
      const label = url ? tree({
        label: url,
        nodes: [pkgRef]
      }).trim() : pkgRef
      let item = {
        label
      }

      // stacks all packages together under the same item
      if (seenUrls.has(url)) {
        item = seenUrls.get(url)
        item.label += `, ${pkgRef}`
        return null
      } else {
        seenUrls.set(url, item)
      }

      return item
    },

    // puts child nodes back into returned archy
    // output while also filtering out missing items
    leave: (item, children) => {
      if (item)
        item.nodes = children.filter(Boolean)

      return item
    },

    // turns tree-like object return by libnpmfund
    // into children to be properly read by treeverse
    getChildren: (node) =>
      Object.keys(node.dependencies || {})
        .map(key => ({
          name: key,
          ...node.dependencies[key]
        }))
  })

  return tree(result)
}

function openFundingUrl ({ actualTree, spec, fundingSourceNumber }) {
  const retrievePackageMetadata = () => {
    const arg = npa(spec, actualTree.path)
    let packageMetadata
    if (arg.type === 'directory') {
      if (actualTree.path === arg.where) {
        packageMetadata = actualTree.package
      } else {
        for (const item of actualTree.inventory.values()) {
          if (item.path === arg.where) {
            packageMetadata = item.package
          }
        }
      }
    } else {
      const [ item ] = [
        ...actualTree.inventory.values()
      ]
        .filter(i => i && i.package &&
          i.package.name === arg.name &&
          semver.valid(i.package.version))
        .sort((a, b) => semver.rcompare(a.package.version, b.package.version))

      if (item) {
        packageMetadata = item.package
      } else {
        // TODO: reenable pacote.manifest call for non-project-dependencies
      }
    }
    return packageMetadata
  }

  const { funding } = retrievePackageMetadata() || {}
  const validSources = [].concat(normalizeFunding(funding)).filter(isValidFunding)

  if (validSources.length === 1 || (fundingSourceNumber > 0 && fundingSourceNumber <= validSources.length)) {
    const { type, url } = validSources[fundingSourceNumber ? fundingSourceNumber - 1 : 0]
    const typePrefix = type ? `${type} funding` : 'Funding'
    const msg = `${typePrefix} available at the following URL`
    return new Promise((resolve, reject) =>
      openUrl(url, msg, err => err
        ? reject(err)
        : resolve()
      ))
  } else if (!(fundingSourceNumber >= 1)) {
    validSources.forEach(({ type, url }, i) => {
      const typePrefix = type ? `${type} funding` : 'Funding'
      const msg = `${typePrefix} available at the following URL`
      output(`${i + 1}: ${msg}: ${url}`)
    })
    output('Run `npm fund [<@scope>/]<pkg> --which=1`, for example, to open the first funding URL listed in that package')
  } else {
    const noFundingError = new Error(`No valid funding method available for: ${spec}`)
    noFundingError.code = 'ENOFUND'

    throw noFundingError
  }
}

const fund = async (args) => {
  const opts = npm.flatOptions
  const spec = args[0]
  const numberArg = opts.which

  const fundingSourceNumber = numberArg && parseInt(numberArg, 10)

  if (numberArg !== undefined && (String(fundingSourceNumber) !== numberArg || fundingSourceNumber < 1)) {
    const err = new Error('`npm fund [<@scope>/]<pkg> [--which=fundingSourceNumber]` must be given a positive integer')
    err.code = 'EFUNDNUMBER'
    throw err
  }

  if (opts.global) {
    const err = new Error('`npm fund` does not support global packages')
    err.code = 'EFUNDGLOBAL'
    throw err
  }

  const where = npm.prefix
  const arb = new Arborist({ ...opts, path: where })
  const actualTree = await arb.loadActual()

  if (spec) {
    openFundingUrl({
      actualTree,
      spec,
      fundingSourceNumber
    })
    return
  }

  const print = opts.json
    ? printJSON
    : printHuman

  output(
    print(
      await read({ tree: actualTree }),
      opts
    )
  )
}

module.exports = Object.assign(cmd, { usage, completion })
