/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSALWatchdog class
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Monitors root files and directories for changes of any kind,
 *                  to notify the respective event listeners who can then take
 *                  appropriate action.
 *
 * END HEADER
 */

import chokidar from 'chokidar'
import EventEmitter from 'events'

import ignoreDir from '@common/util/ignore-dir'
import ignoreFile from '@common/util/ignore-file'
import isFile from '@common/util/is-file'
import isDir from '@common/util/is-dir'

import { ignoreDirs as IGNORE_DIR_REGEXP } from '@common/data.json'

import { WatchdogEvent } from '@dts/main/fsal'
import LogProvider from '@providers/log'
import { hasMdOrCodeExt } from './util/is-md-or-code-file'
import ConfigProvider from '@providers/config'

export default class FSALWatchdog extends EventEmitter {
  private _booting: boolean
  private _process: chokidar.FSWatcher|null
  private _ignoredEvents: WatchdogEvent[]
  private readonly _logger: LogProvider
  private readonly _config: ConfigProvider
  private readonly _paths: string[]

  /**
   * Create a new watcher instance
   */
  constructor (logger: LogProvider, config: ConfigProvider) {
    super() // Setup the Event Emitter
    this._logger = logger
    this._config = config
    this._booting = false
    this._process = null
    this._paths = []
    this._ignoredEvents = []
  }

  /**
   * Shuts down the service provider.
   * @return {void} No return.
   */
  async shutdown (): Promise<void> {
    if (this._process !== null) {
      await this._process.close()
    }
  }

  /**
   * Initiate watching process and stage all changes in the staged-array
   */
  start (): this {
    // Don't boot up twice and only boot if there's at least one path
    if (this._paths.length < 1 || this.isBooting()) {
      return this
    }

    this._booting = true // Lock the start function

    // chokidar's ignored-setting is compatible to anymatch, so we can
    // pass an array containing the standard dotted directory-indicators,
    // directories that should be ignored and a function that returns true
    // for all files that are _not_ in the filetypes list (whitelisting)
    // Further reading: https://github.com/micromatch/anymatch
    const ignoreDirs = [/(^|[/\\])\../]

    // Create new regexps from the strings
    for (let x of IGNORE_DIR_REGEXP) ignoreDirs.push(new RegExp(x, 'i'))

    const options: chokidar.WatchOptions = {
      useFsEvents: process.platform === 'darwin',
      ignored: ignoreDirs,
      persistent: true,
      ignoreInitial: true, // Do not track the initial watch as changes
      followSymlinks: true, // Follow symlinks
      ignorePermissionErrors: true, // In the worst case one has to reboot the software, but so it looks nicer.

      // Chokidar is an asshole to deal with, and as long as we cannot get fsevents
      // to be compiled together with Electron, chokidar will *always* fall back
      // to polling on macOS platforms. This is the bad news. The good news,
      // however, is, that even Microsoft itself has this problem. So their
      // approach was simply to only poll the file system every 5 seconds, which
      // does, in fact, reduce the load on the CPU *big time*. This means that
      // we simply use this setting and then be done with it for the time being.
      //
      // Thank you for reading this far! If you, person from the future, have
      // the cure for what ails our file watching, please come forward and
      // propose a Pull Request like a lover proposes to their loved ones!
      //
      // cf. on ye misery:
      // https://github.com/microsoft/vscode/blob/master/src/vs/platform/files/node/watcher/unix/chokidarWatcherService.ts
      interval: 5000,
      binaryInterval: 5000
    }

    if (this._config.get('watchdog.activatePolling') as boolean) {
      let threshold: number = this._config.get('watchdog.stabilityThreshold')
      if (typeof threshold !== 'number' || threshold < 0) {
        threshold = 1000
      }

      // From chokidar docs: "[...] in some cases some change events will be
      // emitted while the file is being written." --> hence activate this.
      options.awaitWriteFinish = {
        stabilityThreshold: threshold,
        pollInterval: 100
      }

      this._logger.info(`[FSAL Watchdog] Activating file polling with a threshold of ${threshold}ms.`)
    }

    // Begin watching the pushed paths
    this._process = chokidar.watch(this._paths, options)

    this._process.on('ready', () => {
      if (this._process === null) {
        this._logger.error('[FSAL Watchdog] The chokidar process fired a ready event but the process itself is gone!')
        return
      }

      if (process.platform === 'darwin' && this._process.options.useFsEvents === false) {
        this._logger.warning('[FSAL Watchdog] The chokidar process falls back to polling. This may lead to a high CPU usage.')
      } else if (process.platform === 'darwin' && this._process.options.useFsEvents === true) {
        this._logger.info('[FSAL Watchdog] The chokidar process utilizes fsevents. File changes are deteced without polling.')
      }

      // Add all paths that may have been added to the array while the process
      // was starting up.
      const alreadyWatched = Object.keys(this._process.getWatched())
      for (const p of this._paths) {
        if (!alreadyWatched.includes(p)) {
          this._process.add(p)
        }
      }
      this._booting = false // Unlock the start function
    })

    this._process.on('all', (event: string, p: string) => {
      // Should we ignore that event?
      const shouldIgnore = this._ignoredEvents.findIndex(e => {
        return e.event === event && e.path === p
      })

      if (shouldIgnore > -1) {
        // Yup
        const i = this._ignoredEvents[shouldIgnore]
        this._logger.info(`[WATCHDOG] Ignore event: ${i.event}:${i.path}`)
        this._ignoredEvents.splice(shouldIgnore, 1)
        return
      }

      // Determine that these are real and valid files/dirs
      const dir = (event === 'unlinkDir') ? true : isDir(p)
      const file = (event === 'unlink') ? true : isFile(p)
      const otherFile = !hasMdOrCodeExt(p)

      // Only watch changes in directories and supported files
      if ((dir && !ignoreDir(p)) || (file && (!ignoreFile(p) || otherFile))) {
        this._logger.info(`[WATCHDOG] Emitting event: ${event}:${p}`)
        // Emit the event for the respective path.
        this.emit('change', event, p)
      }
    })

    return this
  }

  /**
   * Is the process currently booting up?
   * @return {Boolean} True, if it's booting and false if it's not.
   */
  isBooting (): boolean {
    return this._booting
  }

  /**
   * Adds a path to the currently watched paths
   * @param {String} p A new directory or file to be watched
   */
  watch (p: string): this {
    if (this._paths.includes(p)) {
      return this
    }

    // Add the path to the watched
    this._paths.push(p)

    if (this._process === null && !this.isBooting()) {
      // Boot the watchdog if not done yet.
      this.start()
    } else if (this._process !== null && !this.isBooting()) {
      // If the watchdog is ready, the _process may accept new files and
      // folders. As soon as the watchdog becomes ready, it will automatically
      // add all _paths to watch that have been collected during the startup
      // of the watchdog.
      this._process.add(p)
    }

    return this
  }

  /**
   * Removes a path from the watchdog process
   * @param  {String} p The path to be unwatched
   * @return {ZettlrWatchdog}   This for chainability
   */
  unwatch (p: string): this {
    if (!this._paths.includes(p)) {
      return this
    }

    this._paths.splice(this._paths.indexOf(p), 1)
    if (this._process !== null) {
      this._process.unwatch(p)
    } else {
      this._logger.error(`[FSAL Watchdog] Unwatching path ${p}, but the chokidar process is gone. This may indicate a bug.`)
    }

    return this
  }

  /**
   * Adds events in the form { path: '', event: '' } to the ignore list.
   * @param {Array} events An array of path/event-objects to ignore
   */
  ignoreEvents (events: WatchdogEvent[]): boolean {
    if (events.length === 0) {
      return false
    }

    this._ignoredEvents = this._ignoredEvents.concat(events)

    return true
  }
}
