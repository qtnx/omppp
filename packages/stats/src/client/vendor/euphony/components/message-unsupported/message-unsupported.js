import{v as s,i as e,n as t,r as n,a,b as i,x as o,w as r}from"../../chunks/third-party.js";import{p}from"../../chunks/prismjs.js";import{p as l}from"../../chunks/css-inline.js";import{i as c}from"../../chunks/icon-play.js";import{c as d}from"../../chunks/css/message-unsupported.js";var g=Object.defineProperty,u=Object.getOwnPropertyDescriptor,h=(s,e,t,n)=>{for(var a,i=n>1?void 0:n?u(e,t):e,o=s.length-1;o>=0;o--)(a=s[o])&&(i=(n?a(e,t,i):a(i))||i);return n&&i&&g(e,t,i),i};let m=class extends a{constructor(){super(...arguments),this.message=null,this.isCollapsed=!0}firstUpdated(){}willUpdate(s){s.has("message")&&(this.isCollapsed=!0)}async initData(){}getHighlightedCode(s,e){if(!(e in p.languages))return i`${s}`;const t=p.languages[e],n=p.highlight(s,t,e);return i`${o(n)}`}getRawContentJSON(){if(!this.message)return"";try{return JSON.stringify(this.message.content,null,2)}catch{return String(this.message.content)}}getContentTypeLabel(){if(!this.message)return"unknown";const s=this.message.content;return"object"==typeof s&&null!==s&&"content_type"in s?s.content_type??"unknown":"unknown"}render(){if(!this.message)return i``;const s=this.getRawContentJSON();return i`
      <div class="message-content">
        <div class="error-label">
          <span>Unsupported message content type: ${this.getContentTypeLabel()}</span>
        </div>
        <div class="content-block">
          <div class="label">
            <button
              class="svg-icon collapse-icon"
              ?is-collapsed=${this.isCollapsed}
              @click=${s=>{s.preventDefault(),s.stopPropagation(),this.isCollapsed=!this.isCollapsed}}
            >
              ${o(c)}
            </button>
            <span>Raw Content</span>
          </div>

          <div class="message-text-container" ?is-hidden=${this.isCollapsed}>
            <pre class="message-pre"><code>${this.getHighlightedCode(s,"json")}</code></pre>
          </div>
        </div>
      </div>
    `}};m.styles=[e`
      ${s(d)}
      ${s(l)}
    `],h([t({attribute:!1})],m.prototype,"message",2),h([n()],m.prototype,"isCollapsed",2),m=h([r("euphony-message-unsupported")],m);export{m as EuphonyMessageUnsupported};