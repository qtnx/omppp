import{v as t,i as e,n as s,a,b as o,w as r}from"../../chunks/third-party.js";import{g as n,a as i}from"../../chunks/harmony-types.js";import{g as l}from"../../chunks/utils.js";import{c as d}from"../../chunks/css/message-text.js";var p=Object.defineProperty,h=Object.getOwnPropertyDescriptor,m=(t,e,s,a)=>{for(var o,r=a>1?void 0:a?h(e,s):e,n=t.length-1;n>=0;n--)(o=t[n])&&(r=(a?o(e,s,r):o(r))||r);return a&&r&&p(e,s,r),r};let g=class extends a{constructor(){super(),this.message=null,this.shouldRenderMarkdown=!1,this.markdownAllowedTags=null,this.markdownAllowedAttributes=null,this.isTranslation=!1,this.isEditable=!1,this.getEditableTemplate=t=>o` <!-- Important to avoid new line and whitespace here -->
      <!-- prettier-ignore -->
      <div
      class="message-text"
      contenteditable="true"
      .innerText=${t}
      @input=${t=>{this.messageTextChanged(t)}}
    ></div>`}firstUpdated(){}willUpdate(t){if(t.has("message")&&this.message){const t=n(this.message.content);if("text"!==t)throw new Error(`Invalid message type, expect text, but got: ${t}`)}}async initData(){}messageTextChanged(t){const e=t.target.innerText,s=new CustomEvent("message-text-changed",{detail:e,bubbles:!0,composed:!0});this.dispatchEvent(s)}render(){if(null===this.message)return o``;const t=i(this.message.content).text;let e=o``;return e=this.isEditable?this.getEditableTemplate(t):l(t,this.shouldRenderMarkdown,this.markdownAllowedTags,this.markdownAllowedAttributes),o`
      <div class="message-content" ?is-translation=${this.isTranslation}>
        ${e}
      </div>
    `}};g.styles=[e`
      ${t(d)}
    `],m([s({attribute:!1})],g.prototype,"message",2),m([s({type:Boolean})],g.prototype,"shouldRenderMarkdown",2),m([s({type:Array})],g.prototype,"markdownAllowedTags",2),m([s({type:Array})],g.prototype,"markdownAllowedAttributes",2),m([s({type:Boolean})],g.prototype,"isTranslation",2),m([s({type:Boolean})],g.prototype,"isEditable",2),g=m([r("euphony-message-text")],g);export{g as EuphonyMessageText};