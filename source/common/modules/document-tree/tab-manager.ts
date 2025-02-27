import { OpenDocument } from '@dts/common/documents'
import { isMdOrCodeFile } from '@providers/fsal/util/is-md-or-code-file'
import { promises as fs, constants as FSConstants } from 'fs'

export class TabManager {
  private readonly _openFiles: OpenDocument[]
  private _activeFile: OpenDocument|null
  private readonly _sessionHistory: string[]
  private _sessionPointer: number

  constructor () {
    this._openFiles = []
    this._activeFile = null
    this._sessionHistory = []
    this._sessionPointer = -1
  }

  // GETTERS AND SETTERS

  /**
   * Returns the list of currently opened files in this tab manager
   *
   * @return  {OpenDocument[]}  The currently open documents
   */
  public get openFiles (): OpenDocument[] {
    return this._openFiles
  }

  /**
   * Sets the active file to the one given; can either be an OpenDocument or
   * a file path. Provide null to unset
   *
   * @param  {OpenDocument|string|null}  file  The new active file
   */
  public set activeFile (file: OpenDocument|string|null) {
    if (typeof file === 'string') {
      const doc = this._openFiles.find(doc => doc.path === file)
      if (doc === undefined) {
        return
      }
      file = doc
    }

    this._activeFile = file
  }

  /**
   * Returns the current active file
   *
   * @return  {OpenDocument|null}  The active file or null
   */
  public get activeFile (): OpenDocument|null {
    return this._activeFile
  }

  // PUBLIC METHODS

  /**
   * Sorts the openFiles according to hashArray, and returns the new sorting.
   *
   * @param {Array} pathArray An array with absolute paths to sort with
   *
   * @return {Array} The new sorting
   */
  public sortOpenFiles (pathArray: string[]): boolean {
    // Only sort if something changed
    if (pathArray.length === this._openFiles.length) {
      let somethingChanged = false
      for (let i = 0; i < pathArray.length; i++) {
        if (this._openFiles[i].path !== pathArray[i]) {
          somethingChanged = true
          break
        }
      }

      if (!somethingChanged) {
        return false
      }
    }

    // Simply re-sort based on the new paths
    this._openFiles.sort((a, b) => {
      return pathArray.indexOf(a.path) - pathArray.indexOf(b.path)
    })

    this.movePinnedTabsLeft()

    return true
  }

  /**
   * This function (re)sorts the open files solely based on their pinned status
   */
  private movePinnedTabsLeft (): void {
    // Also make sure that pinned tabs are all grouped to the left before sync
    this._openFiles.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return 0
    })
  }

  /**
   * Returns a file's metadata including the contents.
   *
   * @param  {string}  file   The absolute file path
   * @param  {boolean} newTab Optional. If true, will always prevent exchanging the currently active file.
   *
   * @return {Promise<MDFileDescriptor|CodeFileDescriptor>} The file's descriptor
   */
  public async openFile (
    filePath: string,
    modifyHistory?: boolean
  ): Promise<boolean> {
    if (this.activeFile?.path === filePath) {
      return false
    }
    const openFile = this._openFiles.find(file => file.path === filePath)

    // Remove the file from the session history if applicable
    if (modifyHistory !== false) {
      const sessionIndex = this._sessionHistory.indexOf(filePath)
      if (sessionIndex > -1) {
        this._sessionHistory.splice(sessionIndex, 1)
      }
    }

    // If the file is already open, we just set it as the active one and be done
    // with it, no further action needed
    if (openFile !== undefined) {
      if (modifyHistory !== false) {
        this._sessionHistory.push(filePath)
        this._sessionPointer = this._sessionHistory.length - 1
      }
      this.activeFile = openFile
      return false
    }

    // The file is not open, so first test if we can actually open it, and then
    // load it into our state.
    try {
      await fs.access(filePath,
        FSConstants.F_OK | // File must be visible to the process
        FSConstants.R_OK | // We need to read it
        FSConstants.W_OK // And write it
      )
    } catch (err: any) {
      return false
    }

    if (!isMdOrCodeFile(filePath)) {
      return false
    }

    const stat = await fs.lstat(filePath)

    const file: OpenDocument = {
      path: filePath,
      pinned: false,
      modtime: stat.mtime.getTime()
    }

    if (this._activeFile !== null) {
      // ... behind our active file
      const idx = this._openFiles.indexOf(this._activeFile)
      this._openFiles.splice(idx + 1, 0, file)
    } else {
      // ... or at the end
      this._openFiles.push(file)
    }

    // Update all required states. Especially make sure to re-sort this to
    // ensure the new file (unpinned) doesn't end up in between several pinned
    // files.
    this.sortOpenFiles(this._openFiles.map(d => d.path))

    this.activeFile = file

    if (modifyHistory !== false) {
      this._sessionHistory.push(filePath)
      this._sessionPointer = this._sessionHistory.length - 1
    }

    return true
  }

  /**
   * Closes the given file if it's in fact open. This function deals with every
   * potential problem such as retrieving user consent to closing the file if it
   * is modified.
   *
   * @param   {MDFileDescriptor|CodeFileDescriptor}  file  The file to be closed
   *
   * @return  {boolean}                                    Whether or not the file was closed
   */
  public closeFile (file: OpenDocument|string): boolean {
    if (typeof file === 'string') {
      const doc = this._openFiles.find(doc => doc.path === file)
      if (doc !== undefined) {
        file = doc
      } else {
        return false
      }
    }
    if (!this._openFiles.includes(file)) {
      return false // All good, we didn't even have to close the file.
    }

    if (file.pinned) {
      // TODO this._app.log.warning(`[Document Provider] Refusing to close pinned file ${file.path}`)
      return false
    }

    // Retrieve the index of the active file and whether it's an active file
    const activeFileIdx = (this._activeFile === null) ? -1 : this._openFiles.indexOf(this._activeFile)
    const isActive = this._activeFile === file

    // Then remove the file from the list of open files
    this._openFiles.splice(this._openFiles.indexOf(file), 1)

    // Now, if we just closed the active file, we need to make another file
    // active, or none, if there are no more open files active.
    if (isActive) {
      if (this._openFiles.length > 0 && activeFileIdx > 0) {
        this.activeFile = this._openFiles[activeFileIdx - 1]
      } else if (this._openFiles.length > 0 && activeFileIdx === 0) {
        this.activeFile = this._openFiles[0]
      } else {
        this.activeFile = null
      }
    }

    return true
  }

  /**
   * Goes back in the session history and opens the previous file
   */
  public async back (): Promise<void> {
    await this._moveThroughHistory(-1)
  }

  /**
   * Goes forward in the session history and opens the next file
   */
  public async forward (): Promise<void> {
    await this._moveThroughHistory(1)
  }

  /**
   * Moves through history using the specified direction
   *
   * @param   {number}  direction  The direction to take. Negative = back, positive = forward
   */
  private async _moveThroughHistory (direction: number): Promise<void> {
    // Always make sure the session pointer is valid
    if (this._sessionPointer < 0 || this._sessionPointer > this._sessionHistory.length - 1) {
      this._sessionPointer = this._sessionHistory.length - 1
    }

    const targetIndex = this._sessionPointer + direction

    console.log(this._sessionHistory)

    if (targetIndex > this._sessionHistory.length - 1 || targetIndex < 0) {
      return console.log('Out of bounds') // Cannot move: Out of bounds
    }

    // Move the pointer
    this._sessionPointer = targetIndex
    const pathToOpen = this._sessionHistory[this._sessionPointer]

    // Open that file, but tell the opener explicitly not to modify the state
    await this.openFile(pathToOpen, false)
  }

  /**
   * Sets the pinned status for the given file.
   *
   * @param   {string}   filePath        The absolute path to the file
   * @param   {boolean}  shouldBePinned  Whether the file should be pinned.
   */
  public setPinnedStatus (filePath: string, shouldBePinned: boolean): void {
    const idx = this._openFiles.findIndex(doc => doc.path === filePath)
    if (idx > -1) {
      this._openFiles[idx].pinned = shouldBePinned
      this.movePinnedTabsLeft()
    }
  }

  // API METHODS

  /**
   * Returns a JSON serializable representation of the tab manager instance
   *
   * @return  {any}     The JSON data
   */
  public toJSON (): any {
    return {
      openFiles: this._openFiles,
      activeFile: this._activeFile
    }
  }
}
