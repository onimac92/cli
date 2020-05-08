'use strict'

const archy = require('archy')
const Arborist = require('@npmcli/arborist')
const npa = require('npm-package-arg')
const { breadth } = require('treeverse')

const npm = require('./npm.js')
const output = require('./utils/output.js')
const openUrl = require('./utils/open-url.js')
const {
  getFundingInfo,
  retrieveFunding,
  validFundingField
} = require('./utils/funding.js')
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

// the human-printable version does some special things that turned out to be
// verbose but hopefully not hard to follow: we stack up items that have
// a shared url and make sure they're printed at the highest level possible
function printHuman (fundingInfo, opts) {
  const { name, version } = fundingInfo
  const header = getPrintableName({ name, version })
  const result = {}
  const seenUrls = new Map()
  let prev = fundingInfo
  let parent = result

  const tree = obj =>
    archy(obj, '', { unicode: opts.unicode })

  breadth({
    tree: prev,
    visit: ({ name, version, funding }) => {
      const { url } = funding || {}
      const pkgRef = getPrintableName({ name, version })
      const label = url ? tree({
        label: url,
        nodes: [pkgRef]
      }).trim() : pkgRef
      let item = {
        label,
        nodes: []
      }

      if (seenUrls.has(url)) {
        item = seenUrls.get(url)
        item.label += `, ${pkgRef}`
      } else {
        parent.nodes = (parent.nodes || []).concat(item)
        seenUrls.set(url, item)
      }

      return item
    },
    getChildren: (node, nodeResult) => {
      if (prev.dependencies &&
        !Object.hasOwnProperty.call(prev.dependencies, node.name)) {
        prev = node
        parent = nodeResult
      }
      return Object.keys(node.dependencies || {})
        .map(key => ({
          name: key,
          ...node.dependencies[key]
        }))
    }
  })

  const [root] = result.nodes
  return tree(root.label !== header ? { label: header, nodes: [root] } : root)
}

function openFundingUrl ({ actualTree, spec, fundingSourceNumber }) {
  const retrievePackageMetadata = () => {
    const arg = npa(spec, actualTree.path)
    let packageMetadata = {}
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
      const item = actualTree.inventory.query('name', arg.name)
      if (item) {
        packageMetadata = item.package
      } else {
        // TODO: reenable pacote.manifest call for non-project-dependencies
      }
    }
    return packageMetadata
  }

  const { funding } = retrievePackageMetadata()
  const validSources = [].concat(retrieveFunding(funding)).filter(validFundingField)

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
      getFundingInfo(actualTree),
      opts
    )
  )
}

module.exports = Object.assign(cmd, { usage, completion })
