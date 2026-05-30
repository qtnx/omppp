import{v as e,i as t,n as s,r as i,a as o,b as n,x as l,w as a}from"../../chunks/third-party.js";import{p as r}from"../../chunks/prismjs.js";import{g as d}from"../../chunks/utils.js";import{g as c,a as p}from"../../chunks/harmony-types.js";import{p as h}from"../../chunks/css-inline.js";import{i as v}from"../../chunks/icon-play.js";import{c as m}from"../../chunks/css/message-developer-content.js";var g=Object.defineProperty,u=Object.getOwnPropertyDescriptor,b=(e,t,s,i)=>{for(var o,n=i>1?void 0:i?u(t,s):t,l=e.length-1;l>=0;l--)(o=e[l])&&(n=(i?o(t,s,n):o(n))||n);return i&&n&&g(t,s,n),n};let f=class extends o{constructor(){super(),this.message=null,this.shouldRenderMarkdown=!1,this.markdownAllowedTags=null,this.markdownAllowedAttributes=null,this.isEditable=!1,this.blockContents=[],this.getEditableTemplate=(e,t)=>n` <!-- Important to avoid new line and whitespace here -->
      <!-- prettier-ignore -->
      <div
      class="message-text"
      contenteditable="true"
      .innerText=${e}
      @input=${e=>{this.messageTextChanged(e,t)}}
    ></div>`}firstUpdated(){}willUpdate(e){if(e.has("message")||e.has("isEditable")){if(this.message){const e=c(this.message.content);if("developer"!==e)throw new Error(`Invalid message type, expect developer, but got: ${e}`)}this.resetBlockContents()}}async initData(){}messageTextChanged(e,t){const s={...t,newContent:e.target.innerText},i=new CustomEvent("message-developer-content-changed",{detail:s,bubbles:!0,composed:!0});this.dispatchEvent(i)}resetBlockContents(){if(null===this.message)throw new Error("Message is null");this.blockContents=[];const e=p(this.message.content),t=!this.isEditable;let s=[];"string"==typeof e.instructions&&(s=[e.instructions]);for(const[e,i]of s.entries())this.blockContents.push({label:`Instruction #${e}`,content:i,isContentHTML:!1,isCollapsed:t,editInfo:{location:"instruction",index:e}});if(e.tools)for(const s of Object.keys(e.tools)){const i=e.tools[s];let o=this.renderNamespaceTable(s,i.name,i.description??"",!1);for(const[e,t]of i.tools.entries()){let s=n``;s=n`${s}
            <div class="cell-left">Name</div>
            <div class="cell-right">${t.name}</div>`,s=n`${s}
            <div class="cell-left">Description</div>
            <div class="cell-right">${t.description}</div>`,t.parameters&&(s=n`${s}
              <div class="cell-left">Parameters</div>
              <div class="cell-right">
                ${JSON.stringify(t.parameters,null,2)}
              </div>`),o=n`${o}
            <div class="cell-left">Tool ${e}</div>
            <div class="cell-right">
              <div class="content">
                <div class="config-table">${s}</div>
              </div>
            </div> `}o=n`<div class="config-table">${o}</div>`,this.blockContents.push({label:`Tool Namespace: ${s}`,content:o,isContentHTML:!0,isCollapsed:t,editableHTML:n`<div class="config-table">
            ${this.renderNamespaceTable(s,i.name,i.description??"",!0)}
          </div>`})}}getHighlightedCode(e,t){if(!(t in r.languages))return n`${e}`;const s=r.languages[t],i=r.highlight(e,s,t);return n`${l(i)}`}renderNamespaceTable(e,t,s,i){return n`
      <div class="cell-left">Name</div>
      <div class="cell-right">
        ${i?this.getEditableTemplate(t,{location:"tool_namespace_name",index:e}):t}
      </div>
      <div class="cell-left">Description</div>
      <div class="cell-right">
        ${i?this.getEditableTemplate(s,{location:"tool_namespace_description",index:e}):s}
      </div>
    `}render(){if(!this.message)return n``;let e=n``;for(const t of this.blockContents){let s=n``;if(s=t.isContentHTML?this.isEditable&&void 0!==t.editableHTML?n`${t.editableHTML}`:n`${t.content}`:this.isEditable&&void 0!==t.editInfo?this.getEditableTemplate(t.content,{location:"instruction",index:t.editInfo.index}):d(t.content,this.shouldRenderMarkdown,this.markdownAllowedTags,this.markdownAllowedAttributes),t.subBlocks&&t.subBlocks.length>0){let e=n``;for(const s of t.subBlocks){let t=n``;t=s.isContentHTML?n`${s.content}`:d(s.content,this.shouldRenderMarkdown,this.markdownAllowedTags,this.markdownAllowedAttributes),e=n`${e}
            <div class="content-block">
              <div class="label">
                <button
                  class="svg-icon collapse-icon"
                  ?is-collapsed=${s.isCollapsed}
                  @click=${e=>{e.preventDefault(),e.stopPropagation(),s.isCollapsed=!s.isCollapsed,this.requestUpdate()}}
                >
                  ${l(v)}
                </button>
                <span>${s.label}</span>
              </div>

              <!-- Important to avoid new line and whitespace here -->
              <!-- prettier-ignore -->
              <div class="message-text-container"
                ?is-hidden=${s.isCollapsed}
              >${t}</div>
            </div> `}s=n`${s}${e}`}e=n`${e}
        <div class="content-block">
          <div class="label">
            <button
              class="svg-icon collapse-icon"
              ?is-collapsed=${t.isCollapsed}
              @click=${e=>{e.preventDefault(),e.stopPropagation(),t.isCollapsed=!t.isCollapsed,this.requestUpdate()}}
            >
              ${l(v)}
            </button>
            <span>${t.label}</span>
          </div>

          <!-- Important to avoid new line and whitespace here -->
          <!-- prettier-ignore -->
          <div class="message-text-container"
            ?is-hidden=${t.isCollapsed}
          >${s}</div>
        </div> `}return n` <div class="message-content">${e}</div> `}};f.styles=[t`
      ${e(m)}
      ${e(h)}
    `],b([s({attribute:!1})],f.prototype,"message",2),b([s({type:Boolean})],f.prototype,"shouldRenderMarkdown",2),b([s({type:Array})],f.prototype,"markdownAllowedTags",2),b([s({type:Array})],f.prototype,"markdownAllowedAttributes",2),b([s({type:Boolean})],f.prototype,"isEditable",2),b([i()],f.prototype,"blockContents",2),f=b([a("euphony-message-developer-content")],f);export{f as EuphonyMessageDeveloperContent};