'use strict'

const awsSdk = require('aws-sdk')
const cryptoUtil = require('./cryptoUtil')
const recordUtil = require('./recordUtil')
const proto = require('./constants/proto')
const {limitConcurrency} = require('../lib/promiseHelper')
const s3Helper = require('../lib/s3Helper')
const serializer = require('../lib/serializer')

const CONFIG = require('./config')
const PUT_CONCURRENCY = 100
const S3_MAX_RETRIES = 1
const EXPIRED_CREDENTIAL_ERRORS = [
  /The provided token has expired\./,
  /Invalid according to Policy: Policy expired\./
]
const SQS_MAX_LIST_MESSAGES_COUNT = 10
const SQS_MESSAGES_VISIBILITY_TIMEOUT = 30  // In seconds
const SQS_MESSAGES_LONGPOLL_TIMEOUT = 1  // In seconds

const checkFetchStatus = (response) => {
  if (response.status >= 200 && response.status < 300) {
    return response
  } else {
    var error = new Error(response.statusText)
    error.response = response
    throw error
  }
}

const isExpiredCredentialError = (error) => {
  if (!error || !error.message) {
    return false
  }
  return EXPIRED_CREDENTIAL_ERRORS.some((message) => {
    return error.message.match(message)
  })
}

/**
 * @param {{
 *   apiVersion: <string>,
 *   credentialsBytes: <Uint8Array=>, // If missing, will be requested
 *   keys: {{ // User's encryption keys
 *     publicKey: <Uint8Array>, secretKey: <Uint8Array>,
 *     fingerprint: <string=>, secretboxKey: <Uint8Array>}},
 *   serializer: <Object>,
 *   serverUrl: <string>
 * }} opts
 */
const RequestUtil = function (opts = {}) {
  if (!opts.apiVersion) { throw new Error('Missing apiVersion.') }
  if (!opts.keys) { throw new Error('Missing keys.') }
  if (!opts.serializer) { throw new Error('Missing serializer.') }
  if (!opts.serverUrl) { throw new Error('Missing serverUrl.') }
  this.apiVersion = opts.apiVersion
  this.serializer = opts.serializer
  this.serverUrl = opts.serverUrl
  this.userId = Buffer.from(opts.keys.publicKey).toString('base64')
  this.encrypt = cryptoUtil.Encrypt(this.serializer, opts.keys.secretboxKey, CONFIG.nonceCounter)
  this.decrypt = cryptoUtil.Decrypt(this.serializer, opts.keys.secretboxKey)
  this.sign = cryptoUtil.Sign(opts.keys.secretKey)
  this.putConcurrency = opts.putConcurrency || PUT_CONCURRENCY
  // Like put() but with limited concurrency to avoid out of memory/connection
  // errors (net::ERR_INSUFFICIENT_RESOURCES)
  this.bufferedPut = limitConcurrency(RequestUtil.prototype.put, this.putConcurrency)
  if (opts.credentialsBytes) {
    const credentials = this.parseAWSResponse(opts.credentialsBytes)
    this.saveAWSCredentials(credentials)
  }
}

/**
 * Save parsed AWS credential response to be used with AWS requests.
 * @param {{s3: Object, postData: Object, expiration: string, bucket: string, region: string}}
 * @return {Promise} After it resolves, the object is ready to make requests.
 */
RequestUtil.prototype.refreshAWSCredentials = function () {
  // Timestamp checked in server/lib/request-verifier.js
  const timestampString = Math.floor(Date.now() / 1000).toString()
  const userId = window.encodeURIComponent(this.userId)
  const url = `${this.serverUrl}/${userId}/credentials`
  const bytes = this.serializer.stringToByteArray(timestampString)
  const params = {
    method: 'POST',
    body: this.sign(bytes)
  }
  return window.fetch(url, params)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Credential server response ${response.status}`)
      }
      return response.arrayBuffer()
    })
    .then((buffer) => {
      console.log('Refreshed credentials.')
      const credentials = this.parseAWSResponse(new Uint8Array(buffer))
      this.saveAWSCredentials(credentials)
      return Promise.resolve(this)
    })
}

/**
 * Save parsed AWS credential response to be used with AWS requests.
 * @param {{s3: Object, postData: Object, expiration: string, bucket: string, region: string}}
 */
RequestUtil.prototype.saveAWSCredentials = function (parsedResponse) {
  this.s3 = parsedResponse.s3
  this.postData = parsedResponse.postData
  this.expiration = parsedResponse.expiration
  this.bucket = parsedResponse.bucket
  this.region = parsedResponse.region
  this.s3PostEndpoint = `https://${this.bucket}.s3.dualstack.${this.region}.amazonaws.com`

  this.SQS = parsedResponse.SQS
  this.SNS = parsedResponse.SNS
}

/**
 * Parses an AWS credentials endpoint response.
 * @param {Uint8Array} bytes response body
 * @return {{s3: Object, postData: Object, expiration: string, bucket: string, region: string}}
 */
RequestUtil.prototype.parseAWSResponse = function (bytes) {
  const parsedBody = this.serializer.byteArrayToCredentials(bytes)
  const credentials = parsedBody.aws
  if (!credentials) {
    throw new Error('AWS did not return credentials!')
  }
  const postData = parsedBody.s3Post
  if (!postData) {
    throw new Error('AWS did not return s3Post data!')
  }
  const region = parsedBody.region
  if (!region) {
    throw new Error('AWS did not return region!')
  }
  const bucket = parsedBody.bucket
  if (!bucket) {
    throw new Error('AWS did not return bucket!')
  }
  const expiration = credentials.expiration
  const s3 = new awsSdk.S3({
    convertResponseTypes: false,
    credentials: new awsSdk.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }),
    // The bucket name is prepended to the endpoint to build the actual request URL, e.g.
    // https://brave-sync-staging.s3.dualstack.us-west-2.amazonaws.com
    endpoint: `https://s3.dualstack.${region}.amazonaws.com`,
    maxRetries: S3_MAX_RETRIES,
    region: region,
    sslEnabled: true,
    useDualstack: true
  })
  const SQS = new awsSdk.SQS({
    credentials: new awsSdk.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }),
    endpoint: `https://sqs.${region}.amazonaws.com`,
    maxRetries: S3_MAX_RETRIES,
    region: region,
    sslEnabled: true
  })
  const SNS = new awsSdk.SNS({
    credentials: new awsSdk.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }),
    endpoint: `https://sns.${region}.amazonaws.com`,
    maxRetries: S3_MAX_RETRIES,
    region: region,
    sslEnabled: true
  })

  return {s3, postData, expiration, bucket, region, SQS, SNS}
}

/**
 * Get S3 objects in a category.
 * @param {string} category - the category ID
 * @param {number=} startAt return objects with timestamp >= startAt (e.g. 1482435340)
 * @param {number=} maxRecords Limit response to a given number of recods. By default the Sync lib will fetch all matching records, which might take a long time. If falsey, fetch all records.
 * @param {string} platform current platform (laptop | android | ios)
 * @returns {Promise(Array.<Object>)}
 */
 RequestUtil.prototype.list = function (category, startAt, maxRecords, platform) {
  const prefix = `${this.apiVersion}/${this.userId}/${category}`
  let options = {
    MaxKeys: maxRecords || 1000,
    Bucket: this.bucket,
    Prefix: prefix
  }
  if (startAt) { options.StartAfter = `${prefix}/${startAt}` }
  return this.withRetry(() => {
    if (!startAt || 0 === startAt || ((new Date).getTime() - startAt) >
        parseInt(s3Helper.SQS_RETENTION, 10) * 1000) {
      return s3Helper.listObjects(this.s3, options, !!maxRecords)
    }
    // We poll from SQS
    let notificationParams = {
      QueueUrl: `${this.SQSUrl}`,
      AttributeNames: [
        'All'
      ],
      MaxNumberOfMessages: SQS_MAX_LIST_MESSAGES_COUNT,
      MessageAttributeNames: [
        'All'
      ],
      VisibilityTimeout: SQS_MESSAGES_VISIBILITY_TIMEOUT,
      WaitTimeSeconds: SQS_MESSAGES_LONGPOLL_TIMEOUT
    }

    return s3Helper.listNotifications(this.SQS, notificationParams, category,
      `${this.apiVersion}/${encodeURIComponent(this.userId)}/${category}`, platform)
  })
}

/**
 * Creates SNS Topic for the current user.
 * @returns {Promise}
 */
RequestUtil.prototype.createAndSubscribeSNS = function () {
  this.SNSName = `${this.bucket}_sns_${this.userId.replace(/[^A-Za-z0-9]/g, '')}`
  let params = {
    Name: `${this.SNSName}`
  }
  return new Promise((resolve, reject) => {
    this.SNS.createTopic(params, (error, data) => {
      if (error) {
        console.log('SNS creation failed with error: ' + error)
        reject(error)
      } else if (data) {
        this.SNSArn = data.TopicArn
        let topicAttributesParams = {
          AttributeName: "Policy",
          TopicArn: `${data.TopicArn}`,
          AttributeValue: `${this.SNSPolicy(data.TopicArn)}`
        }
        this.SNS.setTopicAttributes(topicAttributesParams, (errorAttr, dataAttr) => {
          if (errorAttr) {
            console.log('SNS setTopicAttributes failed with error: ' + errorAttr)
            reject(errorAttr)
          } else if (dataAttr) {
            let encodedUser = encodeURIComponent(this.userId)
            let bucketNotificationConfiguration = {
              Bucket: `${this.bucket}`,
              NotificationConfiguration: {
                TopicConfigurations: [
                  {
                    Events: [
                      "s3:ObjectCreated:Post"
                    ],
                    TopicArn: `${data.TopicArn}`,
                    Filter: {
                      Key: {
                        FilterRules: [
                          {
                            Name: "prefix",
                            Value: `${this.apiVersion}/${encodedUser}/`
                          }
                        ]
                      }
                    }
                  }
                ]
              }
            }
            this.s3.putBucketNotificationConfiguration(bucketNotificationConfiguration, (errorNotif, dataNotif) => {
              if (errorNotif) {
                console.log('S3 putBucketNotificationConfiguration failed with error: ' + errorNotif)
                reject(errorNotif)
              } else if (dataNotif) {
                resolve([])
              }
            })
          }
        })
      }
    })
  })
}

/**
 * Creates SQS for the current device.
 * @param {string} deviceId
 * @returns {Promise}
 */
RequestUtil.prototype.createAndSubscribeSQS = function (deviceId) {
  // Creating a query for the current userId
  if (!deviceId) {
    throw new Error('createSQS failed. deviceId is null!')
  }
  this.deviceId = deviceId
  this.SQSName = `${this.bucket}_sqs_${this.userId.replace(/[^A-Za-z0-9]/g, '')}_${deviceId}`
  let newQueueParams = {
    QueueName: `${this.SQSName}`,
    Attributes: {
      'MessageRetentionPeriod': s3Helper.SQS_RETENTION
    }
  }
  return new Promise((resolve, reject) => {
      this.SQS.createQueue(newQueueParams, (error, data) => {
        if (error) {
          console.log('SQS creation failed with error: ' + error)
          reject(error)
        } else if (data) {
          this.SQSUrl = data.QueueUrl
          let queueAttributesParams = {
            QueueUrl: data.QueueUrl,
            AttributeNames: [
              'QueueArn'
            ]
          }
          this.SQS.getQueueAttributes(queueAttributesParams, (errorAttr, dataAttr) => {
            if (errorAttr) {
              console.log('SQS.getQueueAttributes failed with error: ' + errorAttr)
              reject(errorAttr)
            } else if (dataAttr) {
              let setQueueAttributesParams = {
                QueueUrl: data.QueueUrl,
                Attributes: {
                  'Policy': `${this.SQSPolicy(dataAttr.Attributes.QueueArn)}`
                }
              }
              this.SQS.setQueueAttributes(setQueueAttributesParams, (errorSetQueueAttr, dataSetQueueAttr) => {
                if (errorSetQueueAttr) {
                  console.log('SQS.setQueueAttributes failed with error: ' + errorSetQueueAttr)
                  reject(errorSetQueueAttr)
                } else if (dataSetQueueAttr) {
                  let subscribeParams = {
                    TopicArn: `${this.SNSArn}`,
                    Protocol: "sqs",
                    Endpoint: `${dataAttr.Attributes.QueueArn}`
                  }
                  this.SNS.subscribe(subscribeParams, (errorSubscribe, dataSubscribe) => {
                    if (errorSubscribe) {
                      console.log('SNS.subscribe failed with error: ' + errorSubscribe)
                      reject(errorSubscribe)
                    } else if (dataSubscribe) {
                      resolve([])
                    }
                  })
                }
              })
            }
          })
        }
      })
 })
}

/**
 * Creates SQS Policy.
 * @param {string} queueArn
 * @returns {Promise}
 */
RequestUtil.prototype.SQSPolicy = function (queueArn) {
  return `
  {
    "Version":"2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": "*",
        "Action": "SQS:SendMessage",
        "Resource": "${queueArn}",
        "Condition": {
          "ArnEquals": {
            "aws:SourceArn": "${this.SNSArn}"
          }
        }
      }
    ]
  }
  `
}

/**
 * Creates SNS Policy.
 * @param {string} snsArn
 * @returns {Promise}
 */
RequestUtil.prototype.SNSPolicy = function (snsArn) {
  return `
  {
    "Version":"2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": "*",
        "Action": "SNS:Publish",
        "Resource": "${snsArn}",
        "Condition": {
          "ArnEquals": {
            "aws:SourceArn": "arn:aws:s3:*:*:${this.bucket}"
          }
        }
      }
    ]
  }
  `
}


/**
 * From an array of S3 keys, extract and decrypt records.
 * @param {Array.<Uint8Array>} s3Objects resolved result of .list()
 * @returns {Array.<Object>}
 */
RequestUtil.prototype.s3ObjectsToRecords = function (s3Objects) {
  const crc = require('crc')
  const radix64 = require('../lib/radix64')
  const output = []
  const partBuffer = {}
  for (let s3Object of s3Objects) {
    const parsedKey = s3Helper.parseS3Key(s3Object.Key)
    const fullCrc = parsedKey.recordCrc
    let data = parsedKey.recordPartString
    if (partBuffer[fullCrc]) {
      partBuffer[fullCrc] = partBuffer[fullCrc].concat(data)
      data = partBuffer[fullCrc]
    }
    const dataBytes = s3Helper.s3StringToByteArray(data)
    const dataCrc = radix64.fromNumber(crc.crc32.unsigned(dataBytes.buffer))
    if (dataCrc === fullCrc) {
      let decrypted = {}
      try {
        decrypted = this.decrypt(dataBytes)
        decrypted.syncTimestamp = parsedKey.timestamp
        output.push(decrypted)
      } catch (e) {
        console.log(`Record with CRC ${crc} can't be decrypted: ${e}`)
      }
      if (partBuffer[fullCrc]) { delete partBuffer[fullCrc] }
    } else {
      partBuffer[fullCrc] = data
    }
  }
  for (let crc in partBuffer) {
    console.log(`Record with CRC ${crc} is missing parts or corrupt.`)
  }
  return output
}

/**
 * Record S3 prefix with current timestamp.
 * {apiVersion}/{userId}/{category}/{timestamp}/
 * @returns {string}
 */
RequestUtil.prototype.currentRecordPrefix = function (category) {
  return `${this.apiVersion}/${this.userId}/${category}/${Date.now()}/`
}

/**
 * Puts a single record, splitting it into multiple objects if needed.
 * See also bufferedPut() assigned in the constructor.
 * @param {string=} category - the category ID
 * @param {object} record - the object content
 */
RequestUtil.prototype.put = function (category, record) {
  const thisCategory = category || recordUtil.getRecordCategory(record)
  if (!recordUtil.CATEGORY_IDS.includes(thisCategory)) {
    throw new Error(`Unsupported sync category: ${category}`)
  }
  const encryptedRecord = this.encrypt(record)
  const s3Prefix = this.currentRecordPrefix(thisCategory)
  const s3Keys = s3Helper.encodeDataToS3KeyArray(s3Prefix, encryptedRecord)
  return this.withRetry(() => {
    const fetchPromises = s3Keys.map((key, _i) => {
      const params = {
        method: 'POST',
        body: this.s3PostFormData(key)
      }
      return window.fetch(this.s3PostEndpoint, params)
        .then(checkFetchStatus)
    })
    return Promise.all(fetchPromises)
  })
}

RequestUtil.prototype.s3PostFormData = function (objectKey) {
  let formData = new FormData() // eslint-disable-line
  formData.append('key', objectKey)
  for (let key of Object.keys(this.postData)) {
    formData.append(key, this.postData[key])
  }
  formData.append('file', new Uint8Array([]))
  return formData
}

/**
 * In S3 you can't delete all keys matching a prefix, so you need to list by
 * prefix then delete them all.
 * @param {string} prefix
 */
RequestUtil.prototype.s3DeletePrefix = function (prefix) {
  return this.withRetry(() => {
    return s3Helper.deletePrefix(this.s3, this.bucket, prefix)
  })
}

RequestUtil.prototype.deleteUser = function () {
  return this.s3DeletePrefix(`${this.apiVersion}/${this.userId}`)
}

/**
 * @param {string} category - the category ID
 */
RequestUtil.prototype.deleteCategory = function (category) {
  return this.s3DeletePrefix(`${this.apiVersion}/${this.userId}/${category}`)
}

/**
 * Delete site settings, which are stored in the preferences collection
 * alongside device records.
 */
RequestUtil.prototype.deleteSiteSettings = function () {
  const prefix = `${this.apiVersion}/${this.userId}/${proto.categories.PREFERENCES}`
  return s3Helper.deletePrefix(this.s3, this.bucket, prefix, (s3Object) => {
    // TODO: Recombine split records
    const parsedKey = s3Helper.parseS3Key(s3Object.Key)
    const decodedData = s3Helper.s3StringToByteArray(parsedKey.recordPartString)
    const record = this.decrypt(decodedData)
    const objectData = serializer.getSyncRecordObjectData(record)
    return objectData === 'siteSetting'
  })
}

/**
 * Wrapper to call a function and refresh credentials if needed.
 * @param {Function(Promise)} Function which returns a Promise.
 * @param {number} retries Retries left. You probably don't need to change this.
 * @param {Error=} previousError Buffer with the previous error, for internal use.
 */
RequestUtil.prototype.withRetry = function (myFun, retries = 1, previousError) {
  if (retries < 0) { throw previousError }

  return new Promise((resolve, reject) => {
    const callMyFun = () => {
      myFun()
        .then((...args) => { resolve(...args) })
        .catch((error) => {
          const retry = () => {
            try {
              this.withRetry(myFun, retries - 1, error)
                .then((...args) => { resolve(...args) })
                .catch((error) => { reject(error) })
            } catch (error) {
              reject(error)
            }
          }
          // window.fetch() requests. checkFetchStatus() appends responses.
          if (error.response) {
            error.response.text().then((body) => {
              error.message = error.message.concat(body)
              retry()
            })
          } else {
            retry()
          }
        })
    }
    if (previousError) {
      if (!isExpiredCredentialError(previousError)) { throw previousError }
      this.refreshAWSCredentials().then(callMyFun)
    } else {
      callMyFun()
    }
  })
}

module.exports = RequestUtil
