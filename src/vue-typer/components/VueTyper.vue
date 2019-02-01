<template lang='pug'>
//-
  Ideally we'd just have span.left and span.right contain all the chars to the left and
  right of the caret, but line-wrapping becomes tricky on some browsers (FF/IE/Edge).
  Until we can find a solution for this, we just create one span per character.
span.vue-typer
  span.left
    char.custom(v-for='l in numLeftChars'
                :val="currentTextArray[l-1]"
                :class="classes[l-1]"
                :key="l-1")
  caret(:class='caretClasses', :animation='caretAnimation')
  span.right
    char.custom(v-for='r in numRightChars'
                :val="currentTextArray[numLeftChars + r - 1]",
                :class='classes[numLeftChars + r - 1]'
                :key="numLeftChars + r - 1")
</template>


<script>
import Caret from './Caret'
import Char from './Char'
import shallowEquals from '../utils/shallow-equals'
import shuffle from '../utils/shuffle'
import split from 'lodash.split'

const STATE = {
  IDLE: 'idle',
  TYPING: 'typing',
  ERASING: 'erasing',
  COMPLETE: 'complete'
}

const CLASSES = {
  SELECTED: 'selected',
  ERASED: 'erased',
  TYPED: 'typed',
  UNTYPED: 'untyped'
}

const ERASE_STYLE = {
  BACKSPACE: 'backspace',
  SELECT_BACK: 'select-back',
  SELECT_ALL: 'select-all',
  CLEAR: 'clear'
}

const FADE = {
  CHAR: 'CHAR', // fade out characters at a time
  WORD: 'WORD', // fade out words at a time
  LINE: 'LINE' // fade out lines at a time
}

const FADE_OUT = {
  FAST: 'FAST',
  SLOW: 'SLOW', // fade out 1 token at a time
  NONE: 'NONE' // do not fade at the end
}

const fadeDefault = {
  offset: 1,
  type: FADE.CHAR,
  key: 'faded',
  out: FADE_OUT.FAST
}

const WHITESPACE_REGEX = new RegExp(/^\s+$/)
const FADE_REGEX = new RegExp(/^([0-9]+)([cwl]{0,1})([sfn]{0,1})$/i)

const fadeObjectValidator = (value) => {
  return (typeof value.offset === 'number' && value.offset >= 0) &&
    (typeof FADE[value.type] !== 'undefined') &&
    (value.key && typeof value.key === 'string') &&
    (typeof FADE_OUT[value.out] !== 'undefined')
}
const fadeValidator = (value) => {
  if (typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return value >= 0
  }
  if (typeof value === 'string') {
    return value.match(FADE_REGEX)
  }
  if (Array.isArray(value)) {
    // todo: check key uniqueness for multiple faders
    // and possible check against using the standard classes
    return value.every(v => fadeValidator(v))
  }
  if (typeof value === 'object') {
    return fadeObjectValidator(value)
  }
  return false
}
const seek = (tokens, text, index, offset, type) => {
  // look through `text` (starting at `index`) for `offset` # of `type` tokens
  // return the index of the character of the end of the last observed token, or -1
  if (index === text.length && offset === 0) {
    return text.length
  }
  if (type === FADE.CHAR) {
    const diff = index + offset
    return diff >= 0 ? diff : -1
  }
  if (index === text.length) {
    index -= 1
  }
  // for WORD and LINE and non-0 offset,
  // use a pre-computed token index
  const direction = offset < 0 ? -1 : 1
  const {INDEX, TOKENS} = tokens[type]
  let tokenIndex = INDEX[index]
  // sanity check: at offset = -1, direction = -1
  // we take the current token and return the end of it
  tokenIndex = tokenIndex + offset - 1 * direction
  const token = TOKENS[tokenIndex]
  if (typeof token === 'undefined') {
    return -1
  }
  return token[direction < 0 ? 0 : 1]
}
const tokenize = (text) => {
  // build a set of arrays to help deal with each type of token
  // for words, store the index of the start of each word in an array
  // for lines, store the index of the start of each line

  // array of (start, end) indices
  const words = []
  const lines = []
  // object of {index: tokenArrayIndex}
  const wordIndex = []
  const lineIndex = []
  const textLength = text.length
  let wordStart = null
  let lineStart = null
  let isNewline = true
  let isSpace = true
  for (var index = 0; index < textLength; index++) {
    const letter = text[index]
    wordIndex.push(words.length)
    lineIndex.push(lines.length)
    if (letter === '\n') {
      if (lineStart !== null) {
        lines.push([lineStart, index - 1])
        lineStart = null
      }
      if (wordStart !== null) {
        words.push([wordStart, index - 1])
        wordStart = null
      }
      isSpace = isNewline = true
    } else if (letter.match(WHITESPACE_REGEX)) {
      if (wordStart !== null) {
        words.push([wordStart, index - 1])
        wordStart = null
      }
      isNewline = false
      isSpace = true
    } else {
      if (isNewline) {
        lineStart = index
      }
      if (isSpace) {
        wordStart = index
      }
      isNewline = isSpace = false
    }
  }
  if (wordStart !== null) {
    words.push([wordStart, textLength - 1])
  }
  if (lineStart !== null) {
    lines.push([lineStart, textLength - 1])
  }
  return {
    WORD: {
      TOKENS: words,
      INDEX: wordIndex
    },
    LINE: {
      TOKENS: lines,
      INDEX: lineIndex
    }
  }
}

export default {
  name: 'VueTyper',
  components: { Caret, Char },

  props: {
    /**
     * Text(s) to type.
     */
    text: {
      type: [String, Array],
      required: true,
      validator(value) {
        if (typeof value === 'string') {
          return value.length > 0
        }
        return value.every(item => typeof item === 'string' && item.length > 0)
      }
    },
    /**
     * Number of extra times to type 'text' after the first time.
     * 0 will type 'text' once, 1 will type twice, Infinity will type forever.
     */
    repeat: {
      type: Number,
      default: Infinity,
      validator: value => value >= 0
    },
    /**
     * Randomly shuffles 'text' (using Fisher-Yates algorithm) before typing it.
     * If 'repeat' > 0, 'text' will be shuffled again before each repetition.
     */
    shuffle: {
      type: Boolean,
      default: false
    },
    /**
     * 'typing'  - starts VueTyper off as a blank space and begins to type the first word.
     * 'erasing' - starts VueTyper off with the first word already typed, and begins to erase.
     */
    initialAction: {
      type: String,
      default: STATE.TYPING,
      validator: value => !!value.match(`^${STATE.TYPING}|${STATE.ERASING}$`)
    },
    /**
     * Milliseconds to wait before typing the first character.
     */
    preTypeDelay: {
      type: Number,
      default: 70,
      validator: value => value >= 0
    },
    /**
     * Milliseconds to wait after typing a character, until the next character is typed.
     */
    typeDelay: {
      type: Number,
      default: 70,
      validator: value => value >= 0
    },
    /**
     * fade: fade configuration
     * Boolean: if non-falsy, the 'faded' class will be added to elements
     * Number: "" with fadeDelay = typeDelay and preFadeDelay as given
     * Object: "" with fadeDelay and preFadeDelay determined by as given
     * String: "" with fadeDelay and preFadeDelay determined so as to "trail"
     *    the type by the given number of letters, setting fadeDelay=typeDelay
     * Array: "" with multiple configurations as given
     */
    fade: {
      type: [Array, Object, Number, Boolean, String],
      default: false,
      validator: fadeValidator
    },
    /**
     * Milliseconds to wait before performing the first erase action (backspace, highlight, etc.).
     */
    preEraseDelay: {
      type: Number,
      default: 2000,
      validator: value => value >= 0
    },
    /**
     * Milliseconds to wait after performing an erase action (backspace, highlight, etc.),
     * until the next erase action can start.
     */
    eraseDelay: {
      type: Number,
      default: 250,
      validator: value => value >= 0
    },
    /**
     * 'backspace'   - Erase one character at a time, like pressing backspace.
     * 'select-back' - Highlight back one character at a time; erase once all characters are highlighted.
     * 'select-all'  - Highlight all characters at once; erase afterwards.
     * 'clear'       - Immediately erases everything; text simply disappears.
     */
    eraseStyle: {
      type: String,
      default: ERASE_STYLE.SELECT_ALL,
      validator: value => Object.keys(ERASE_STYLE).some(item => ERASE_STYLE[item] === value)
    },
    /**
     * Flag to erase everything once VueTyper is finished typing. Set to false to leave the last word visible.
     */
    eraseOnComplete: {
      type: Boolean,
      default: false
    },
    /**
     * Caret animation style. See Caret.vue.
     */
    caretAnimation: String
  },

  data() {
    return {
      state: STATE.IDLE,
      nextState: null,

      spool: [],
      spoolIndex: -1,
      previousTextIndex: -1,
      currentTextIndex: -1,

      repeatCounter: 0,

      actionTimeout: 0,
      actionInterval: 0,
      fades: [],
      fadeOuts: {},
      fading: null,
      classes: []
    }
  },

  computed: {
    eraseShift() {
      let shift = 0
      let index = this.currentTextIndex - 1
      while (this.currentTextArray[index] && this.currentTextArray[index].match(/^\W$/)) {
        shift += 1
        index -= 1
      }
      return shift || 1
    },
    caretClasses() {
      const idle = this.state === STATE.IDLE
      return {
        idle,
        'pre-type': idle && this.nextState === STATE.TYPING,
        'pre-erase': idle && this.nextState === STATE.ERASING,
        typing: this.state === STATE.TYPING,
        selecting: this.state === STATE.ERASING && this.isSelectionBasedEraseStyle,
        erasing: this.state === STATE.ERASING && !this.isSelectionBasedEraseStyle,
        complete: this.state === STATE.COMPLETE
      }
    },
    isSelectionBasedEraseStyle() {
      return !!this.eraseStyle.match(`^${ERASE_STYLE.SELECT_BACK}|${ERASE_STYLE.SELECT_ALL}$`)
    },
    isEraseAllStyle() {
      return !!this.eraseStyle.match(`^${ERASE_STYLE.CLEAR}|${ERASE_STYLE.SELECT_ALL}$`)
    },
    isDoneTyping() {
      return this.currentTextIndex >= this.currentTextLength
    },
    isDoneErasing() {
      // Selection-based erase styles must stay in the highlight stage for one iteration before erasing is finished.
      if (this.isSelectionBasedEraseStyle) {
        return this.currentTextIndex <= 0 && this.previousTextIndex <= 0
      }
      return this.currentTextIndex <= 0
    },
    onLastWord() {
      return this.spoolIndex === this.spool.length - 1
    },
    shouldRepeat() {
      return this.repeatCounter < this.repeat
    },

    currentText() {
      if (this.spoolIndex >= 0 && this.spoolIndex < this.spool.length) {
        return this.spool[this.spoolIndex]
      }
      return ''
    },
    currentTextArray() {
      return split(this.currentText, '')
    },
    currentTextTokens() {
      return tokenize(this.currentTextArray)
    },
    currentTextLength() {
      // NOTE: Using currentText.length will count each individual codepoint as a
      // separate character, which is likely not what you want. currentTextLength will
      // count Unicode characters made up of multiple codepoints as a single character.
      return this.currentTextArray.length
    },

    numLeftChars() {
      return this.currentTextIndex < 0 ? 0 : this.currentTextIndex
    },
    numRightChars() {
      return this.currentTextLength - this.numLeftChars
    }
  },

  mounted() {
    this.init()
  },

  beforeDestroy() {
    this.cancelCurrentAction()
  },

  methods: {
    init() {
      // create this.fades object
      this.initFades()

      // Process the 'text' prop into a typing spool
      if (typeof this.text === 'string') {
        this.spool = [this.text]
      } else {
        // Don't violate one-way binding, make a copy! Vue doesn't make a copy for us to keep things reactive
        let textCopy = this.text.slice()
        textCopy = textCopy.filter(textToType => textToType.length > 0)
        this.spool = textCopy
      }

      this.repeatCounter = 0
      this.resetSpool()

      if (this.initialAction === STATE.TYPING) {
        this.startTyping()
      } else if (this.initialAction === STATE.ERASING) {
        // This is a special case when we start off in erasing mode. The first text is already considered typed, and
        // it may even be the only text in the spool. So don't jump directly into erasing mode (in-case 'repeat' and
        // 'eraseOnComplete' are configured to false), and instead jump to the "we just finished typing a word" phase.
        this.moveCaretToEnd()
        this.onTyped()
      }
    },
    reset() {
      this.cancelCurrentAction()
      this.init()
    },
    resetClasses() {
      const tokens = this.currentTextTokens
      const text = this.currentTextArray
      const currentIndex = this.currentTextIndex
      const fadeIndex = {}
      const fadeOuts = this.fadeOuts
      this.fades.map((fade) => {
        // loop over each fade and determine the
        // new fade index
        const {offset, type} = fade
        const fadeOut = fadeOuts[fade.key]
        const off = typeof fadeOut === 'undefined' ? offset : fadeOut
        const index = seek(tokens, text, currentIndex, -1 * off, type)
        fadeIndex[fade.key] = index
      })
      this.classes = text.map((c, i) => {
        // loop over each character and add the basic classes:
        // TYPED: a character is to the left of the cursor
        // UNTYPED: a character is to the right of the cursor
        // SELECTED: a character is selected to be erased
        // ERASED: a character is erased
        const classes = []
        if (i < currentIndex) {
          classes.push(CLASSES.TYPED)
        } else {
          if (this.state === STATE.ERASING) {
            classes.push(this.isSelectionBasedEraseStyle ? CLASSES.SELECTED : CLASSES.ERASED)
          } else {
            classes.push(CLASSES.UNTYPED)
          }
        }
        // loop over each fade and add in fader classes
        this.fades.map((fade) => {
          if (i < fadeIndex[fade.key]) {
            classes.push(fade.key)
          }
        })
        return classes
      })
    },
    initFades() {
      let fades = this.fade
      if (!fades) {
        // no fades
        this.fades = []
        return
      }
      if (Array.isArray(fades)) {
        // many fades
        this.fades = fades.map((fade) => {
          return this.initFade(fade)
        })
      } else {
        // one fade
        return [this.initFade(fades)]
      }
    },
    initFade(fade) {
      if (typeof fade === 'boolean') {
        return Object.assign({}, fadeDefault)
      }
      if (typeof fade === 'number') {
        // offset
        return Object.assign({}, fadeDefault, {offset: fade})
      }
      if (typeof fade === 'string') {
        // encoded, e.g. "1WS" for 1-word-slow
        const key = 'faded-' + fade
        const matches = fade.match(FADE_REGEX)
        const offset = matches[1].toLowerCase()
        let type = matches[2].toLowerCase()
        let out = matches[3].toLowerCase()
        type = type === 'l' ? FADE.LINE : (
          type === 'w' ? FADE.WORD : FADE.CHAR
        )
        out = out === 'f' ? FADE_OUT.FAST : (
          out === 'n' ? FADE_OUT.NONE : FADE_OUT.SLOW
        )
        return Object.assign({}, fadeDefault, {
          offset: offset,
          type: type,
          key: key,
          out: out
        })
      }
      return Object.assign({}, fadeDefault, fade)
    },
    resetSpool() {
      this.spoolIndex = 0
      if (this.shuffle && this.spool.length > 1) {
        shuffle(this.spool)
      }
    },
    cancelCurrentAction() {
      if (this.actionInterval) {
        clearInterval(this.actionInterval)
        this.actionInterval = 0
      }
      if (this.actionTimeout) {
        clearTimeout(this.actionTimeout)
        this.actionTimeout = 0
      }
    },
    shiftCaret(delta) {
      this.previousTextIndex = this.currentTextIndex
      const newCaretIndex = this.currentTextIndex + delta
      this.currentTextIndex = Math.min(Math.max(newCaretIndex, 0), this.currentTextLength)
    },
    moveCaretToStart() {
      this.previousTextIndex = this.currentTextIndex
      this.currentTextIndex = 0
    },
    moveCaretToEnd() {
      this.previousTextIndex = this.currentTextIndex
      this.currentTextIndex = this.currentTextLength
    },
    typeStep() {
      if (!this.isDoneTyping) {
        this.shiftCaret(1)

        const typedCharIndex = this.previousTextIndex
        const typedChar = this.currentTextArray[typedCharIndex]
        this.$emit('typed-char', typedChar, typedCharIndex)
      }

      if (this.isDoneTyping) {
        this.maybeFadeOut(() => {
          this.cancelCurrentAction()
          this.$nextTick(this.onTyped)
        })
      }
    },
    maybeFadeOut(callback) {
      if (this.fade && this.fading === null) {
        this.fadeOuts = {}
        this.fades.map((fade) => {
          if (fade.out === FADE_OUT.SLOW) {
            this.fadeOuts[fade.key] = fade.offset
            this.fading = true
          } else if (fade.out === FADE_OUT.FAST) {
            this.fadeOuts[fade.key] = 0
            this.fading = true
          } else if (fade.out === FADE_OUT.NONE) {
            // do not fade this
          }
        })
      }
      if (this.fading) {
        const faded = Object.keys(this.fadeOuts).every((key) => {
          return this.fadeOuts[key] <= 0
        })
        if (faded) {
          this.fading = false
        } else {
          // update fadeOuts
          Object.keys(this.fadeOuts).forEach((key) => {
            this.fadeOuts[key] = Math.max(this.fadeOuts[key] - 1, 0)
          })
        }
        this.resetClasses()
      }
      if (!this.fade || this.fading === false) {
        callback()
      }
    },
    eraseStep() {
      if (!this.isDoneErasing) {
        if (this.isEraseAllStyle) {
          this.moveCaretToStart()
        } else {
          this.shiftCaret(-1 * this.eraseShift)
        }
      }

      if (this.isDoneErasing) {
        this.cancelCurrentAction()
        // Ensure every last character is 'erased' in the DOM before proceeding
        this.$nextTick(this.onErased)
      }
    },
    startTyping() {
      if (this.actionTimeout || this.actionInterval) {
        return
      }

      this.moveCaretToStart()

      this.state = STATE.IDLE
      this.nextState = STATE.TYPING
      this.actionTimeout = setTimeout(() => {
        this.state = STATE.TYPING
        this.typeStep()
        if (!this.isDoneTyping) {
          this.actionInterval = setInterval(this.typeStep, this.typeDelay)
        }
      }, this.preTypeDelay)
    },
    startErasing() {
      if (this.actionTimeout || this.actionInterval) {
        return
      }

      this.moveCaretToEnd()

      this.state = STATE.IDLE
      this.nextState = STATE.ERASING
      this.actionTimeout = setTimeout(() => {
        this.state = STATE.ERASING
        this.eraseStep()
        if (!this.isDoneErasing) {
          this.actionInterval = setInterval(this.eraseStep, this.eraseDelay)
        }
      }, this.preEraseDelay)
    },
    onTyped() {
      this.$emit('typed', this.currentText)

      if (this.onLastWord) {
        if (this.eraseOnComplete || this.shouldRepeat) {
          this.startErasing()
        } else {
          this.onComplete()
        }
      } else {
        this.startErasing()
      }
    },
    onErased() {
      this.$emit('erased', this.currentText)

      this.fading = null
      this.fadeOuts = {}
      if (this.onLastWord) {
        if (this.shouldRepeat) {
          this.repeatCounter++
          this.resetSpool()
          this.startTyping()
        } else {
          this.onComplete()
        }
      } else {
        this.spoolIndex++
        this.startTyping()
      }
    },
    onComplete() {
      this.state = STATE.COMPLETE
      this.nextState = null
      this.$emit('completed')
    }
  },
  watch: {
    text(newText, oldText) {
      if (newText === oldText || shallowEquals(newText, oldText)) {
        return
      }
      this.reset()
    },
    repeat() {
      this.reset()
    },
    shuffle() {
      this.reset()
    },
    currentTextArray() {
      this && this.resetClasses()
    },
    currentTextIndex() {
      this && this.resetClasses()
    }
  }
}
</script>

<style scoped lang='scss'>
span.vue-typer {
  cursor: default;
  user-select: none;

  span.left, span.right {
    display: inline;
  }
}
</style>
