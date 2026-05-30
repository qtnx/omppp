import{v as e,i as t,n as s,r as i,a as n,b as l,x as o,w as a}from"../../chunks/third-party.js";import{p as d}from"../../chunks/prismjs.js";import{g as c,a as r}from"../../chunks/harmony-types.js";import{g as h}from"../../chunks/utils.js";import{p}from"../../chunks/css-inline.js";import{i as v}from"../../chunks/icon-play.js";import{c as g}from"../../chunks/css/message-system-content.js";var m=Object.defineProperty,u=Object.getOwnPropertyDescriptor,f=(e,t,s,i)=>{for(var n,l=i>1?void 0:i?u(t,s):t,o=e.length-1;o>=0;o--)(n=e[o])&&(l=(i?n(t,s,l):n(l))||l);return i&&l&&m(t,s,l),l};let b=class extends n{constructor(){super(),this.message=null,this.shouldRenderMarkdown=!1,this.markdownAllowedTags=null,this.markdownAllowedAttributes=null,this.isTranslation=!1,this.isEditable=!1,this.dataFileURL=null,this.blockContents=[],this.getEditableTemplate=(e,t)=>l` <!-- Important to avoid new line and whitespace here -->
      <!-- prettier-ignore -->
      <div
      class="message-text"
      contenteditable="true"
      .innerText=${e}
      @input=${e=>{this.messageTextChanged(e,t)}}
    ></div>`}firstUpdated(){}willUpdate(e){if(e.has("message")||e.has("isEditable")){if(this.message){const e=c(this.message.content);if("system"!==e)throw new Error(`Invalid message type, expect system, but got: ${e}`)}this.resetBlockContents()}}async initData(){}messageTextChanged(e,t){const s={...t,newContent:e.target.innerText},i=new CustomEvent("message-system-content-changed",{detail:s,bubbles:!0,composed:!0});this.dispatchEvent(i)}resetBlockContents(){if(null===this.message)throw new Error("Message is null");this.blockContents=[];const e=r(this.message.content);if(e.model_identity&&this.blockContents.push({label:"Model Identity",content:e.model_identity,isContentHTML:!1,isCollapsed:!1,editInfo:{location:"model_identity",index:0}}),e.conversation_start_date&&this.blockContents.push({label:"Conversation Start Date",content:e.conversation_start_date,isContentHTML:!1,isCollapsed:!1,editInfo:{location:"conversation_start_date",index:0}}),e.knowledge_cutoff&&this.blockContents.push({label:"Knowledge Cutoff",content:e.knowledge_cutoff,isContentHTML:!1,isCollapsed:!1,editInfo:{location:"knowledge_cutoff",index:0}}),e.tools)for(const t in e.tools){let s=l``;s=l`${s}
          <div class="cell-left">Name</div>
          <div class="cell-right">${e.tools[t].name}</div>`,e.tools[t].description&&(s=l`${s}
            <div class="cell-left">Description</div>
            <div class="cell-right">
              ${e.tools[t].description}
            </div>`);for(const[i,n]of e.tools[t].tools.entries()){let e=l``;e=l`${e}
            <div class="cell-left">Name</div>
            <div class="cell-right">${n.name}</div>`,e=l`${e}
            <div class="cell-left">Description</div>
            <div class="cell-right">${n.description}</div>`,n.parameters&&(e=l`${e}
              <div class="cell-left">Parameters</div>
              <div class="cell-right">
                ${JSON.stringify(n.parameters,null,2)}
              </div>`),s=l`${s}
            <div class="cell-left">Tool ${i}</div>
            <div class="cell-right">
              <div class="content">
                <div class="config-table">${e}</div>
              </div>
            </div> `}s=l`<div class="config-table">${s}</div>`,this.blockContents.push({label:`Tool Namespace: ${t}`,content:s,isContentHTML:!0,isCollapsed:!0})}if(e.channel_config){const t=l`
        <div class="config-table">
          <div class="cell-left">Valid Channels</div>
          <div class="cell-right">
            ${e.channel_config.valid_channels.join(", ")}
          </div>

          <div class="cell-left">Channel Required</div>
          <div class="cell-right">
            ${e.channel_config.channel_required?"True":"False"}
          </div>
        </div>
      `,s=l`
        <div class="config-table">
          <div class="cell-left">Valid Channels</div>
          <div class="cell-right">
            ${this.getEditableTemplate(e.channel_config.valid_channels.join(", "),{location:"valid_channels",index:"valid_channels"})}
          </div>

          <div class="cell-left">Channel Required</div>
          <div class="cell-right">
            ${this.getEditableTemplate(e.channel_config.channel_required?"True":"False",{location:"channel_required",index:"channel_required"})}
          </div>
        </div>
      `;this.blockContents.push({label:"Channel Config",content:t,isContentHTML:!0,isCollapsed:!1,editableHTML:s})}}getHighlightedCode(e,t){if(!(t in d.languages))return l`${e}`;const s=d.languages[t],i=d.highlight(e,s,t);return l`${o(i)}`}render(){if(null===this.message)return l``;let e=l``;for(const t of this.blockContents){let s=l``;s=t.isContentHTML?this.isEditable&&void 0!==t.editableHTML?l`${t.editableHTML}`:l`${t.content}`:this.isEditable&&void 0!==t.editInfo?this.getEditableTemplate(t.content,{location:t.editInfo.location,index:t.editInfo.index}):h(t.content,this.shouldRenderMarkdown,this.markdownAllowedTags,this.markdownAllowedAttributes),e=l`${e}
        <div class="content-block">
          <div class="label">
            <button
              class="svg-icon collapse-icon"
              ?is-collapsed=${t.isCollapsed}
              @click=${e=>{e.preventDefault(),e.stopPropagation(),t.isCollapsed=!t.isCollapsed,this.requestUpdate()}}
            >
              ${o(v)}
            </button>
            <span>${t.label}</span>
          </div>

          <!-- Important to avoid new line and whitespace here -->
          <!-- prettier-ignore -->
          <div class="message-text-container"
            ?is-hidden=${t.isCollapsed}
            ?is-translation=${this.isTranslation&&t.label.includes("Instruction")}
          >${s}</div>
        </div> `}return l` <div class="message-content">${e}</div> `}};b.styles=[t`
      ${e(g)}
      ${e(p)}
    `],f([s({attribute:!1})],b.prototype,"message",2),f([s({type:Boolean})],b.prototype,"shouldRenderMarkdown",2),f([s({type:Array})],b.prototype,"markdownAllowedTags",2),f([s({type:Array})],b.prototype,"markdownAllowedAttributes",2),f([s({type:Boolean})],b.prototype,"isTranslation",2),f([s({type:Boolean})],b.prototype,"isEditable",2),f([s({type:String,attribute:"data-file-url"})],b.prototype,"dataFileURL",2),f([i()],b.prototype,"blockContents",2),b=f([a("euphony-message-system-content")],b);export{b as EuphonyMessageSystemContent};