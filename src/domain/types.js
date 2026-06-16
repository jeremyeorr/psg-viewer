/**
 * @typedef {Object} ChannelMeta
 * @property {number} id
 * @property {string} label
 * @property {string} normalizedLabel
 * @property {string} units
 * @property {number} sampleRate
 * @property {number} samplesPerRecord
 * @property {number} physicalMin
 * @property {number} physicalMax
 * @property {number} digitalMin
 * @property {number} digitalMax
 * @property {string} transducer
 * @property {string} prefiltering
 * @property {number} byteOffsetInRecord
 * @property {boolean} isAnnotation
 */

/**
 * @typedef {Object} EdfStudy
 * @property {string} fileName
 * @property {string} patientId
 * @property {string} recordingId
 * @property {string | null} recordingStart
 * @property {number} duration
 * @property {number} recordDuration
 * @property {number} numberOfRecords
 * @property {number} headerBytes
 * @property {number} bytesPerRecord
 * @property {ChannelMeta[]} channels
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} SignalWindowRequest
 * @property {number[]} channelIds
 * @property {number} startSeconds
 * @property {number} durationSeconds
 * @property {number} targetPixelWidth
 */

/**
 * @typedef {Object} ChannelWindow
 * @property {number} channelId
 * @property {number} sampleRate
 * @property {number} samplesRead
 * @property {number} sourceSamples
 * @property {boolean} displayDownsampled
 * @property {number[]} min
 * @property {number[]} max
 * @property {number} visibleMin
 * @property {number} visibleMax
 */

/**
 * @typedef {Object} SignalWindowResult
 * @property {number} startSeconds
 * @property {number} durationSeconds
 * @property {number} bucketCount
 * @property {ChannelWindow[]} channels
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} StageEpoch
 * @property {number} onset
 * @property {number} duration
 * @property {string} stage
 * @property {string=} label
 */

/**
 * @typedef {Object} ScoringEvent
 * @property {number} onset
 * @property {number} duration
 * @property {string} type
 * @property {string=} subtype
 * @property {string=} channel
 * @property {string=} label
 */

/**
 * @typedef {Object} ScoringImportResult
 * @property {StageEpoch[]} stages
 * @property {ScoringEvent[]} events
 * @property {string[]} warnings
 * @property {string} sourceFormat
 * @property {number} epochLength
 */

export {};
