import './styles/demo.scss'

import Vue from 'vue'
import Demo from './Demo'

// eslint-disable-next-line no-new
window.App = new Vue({
  el: '#demo',
  render: createElement => createElement(Demo)
})
