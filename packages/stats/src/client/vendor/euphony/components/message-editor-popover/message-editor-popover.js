import{v as e,i as t,n as s,r as i,a as n,x as o,b as l,w as a}from"../../chunks/third-party.js";import{i as r}from"../../chunks/icon-cross.js";import{R as c}from"../../chunks/harmony-types.js";import{c as p}from"../../chunks/css/message-editor-popover.js";const d='<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg width="100%" height="100%" viewBox="0 0 68 67" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" xmlns:serif="http://www.serif.com/" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">\n    <g id="icon-check">\n        <path d="M26.302,66.557C28.206,66.557 29.72,65.727 30.794,64.066L66.39,7.768C67.22,6.498 67.513,5.473 67.513,4.447C67.513,2.055 65.95,0.443 63.509,0.443C61.751,0.443 60.774,1.029 59.7,2.738L26.106,56.645L8.431,32.816C7.308,31.303 6.233,30.668 4.622,30.668C2.181,30.668 0.423,32.377 0.423,34.818C0.423,35.844 0.862,36.967 1.692,38.041L21.663,63.969C23.03,65.727 24.397,66.557 26.302,66.557Z" style="fill-rule:nonzero;"/>\n    </g>\n</svg>\n',h='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M11.2929 9.29289C11.6834 8.90237 12.3166 8.90237 12.7071 9.29289L16.7071 13.2929C17.0976 13.6834 17.0976 14.3166 16.7071 14.7071C16.3166 15.0976 15.6834 15.0976 15.2929 14.7071L12 11.4142L8.70711 14.7071C8.31658 15.0976 7.68342 15.0976 7.29289 14.7071C6.90237 14.3166 6.90237 13.6834 7.29289 13.2929L11.2929 9.29289Z"\n    fill="currentColor"\n  />\n</svg>\n';var v=Object.defineProperty,u=Object.getOwnPropertyDescriptor,m=(e,t,s,i)=>{for(var n,o=i>1?void 0:i?u(t,s):t,l=e.length-1;l>=0;l--)(n=e[l])&&(o=(i?n(t,s,o):n(o))||o);return i&&o&&v(t,s,o),o};const w=[c.User,c.Assistant,c.System,c.Developer,c.Tool];let g=class extends n{constructor(){super(),this.message=null,this.selectedRole=c.User,this.authorName="",this.recipient="",this.channel=""}firstUpdated(){}willUpdate(e){if(e.has("message")){const e=this.message;if(!e)return;this.selectedRole=e.role,this.authorName=e.name??"",this.recipient=e.recipient??"",this.channel=e.channel??""}}async initData(){}saveButtonClick(){const e={role:this.selectedRole,name:""===this.authorName.trim()?null:this.authorName,recipient:""===this.recipient.trim()?null:this.recipient,channel:""===this.channel.trim()?null:this.channel};this.dispatchEvent(new CustomEvent("save-button-clicked",{detail:e,bubbles:!0,composed:!0}))}cancelButtonClick(){this.dispatchEvent(new Event("cancel-button-clicked",{bubbles:!0,composed:!0}))}render(){return l`
      <div
        class="message-editor-popover"
        tabindex="0"
        @click=${e=>{e.stopPropagation()}}
      >
        <div class="row-group">
          <div class="row-item">
            <div class="label">Role</div>
            <div class="editor-item">
              <span class="select-visible">
                ${this.selectedRole}
                <span class="svg-icon icon-chevron">
                  ${o(h)}
                </span>
              </span>
              <select
                .value=${this.selectedRole}
                @change=${e=>{this.selectedRole=e.target.value}}
              >
                ${w.map(e=>l`<option
                    value=${e}
                    ?selected=${e===this.selectedRole}
                  >
                    ${e}
                  </option>`)}
              </select>
            </div>
          </div>

          <div class="row-item field-row compact-field-row">
            <div class="label">Channel</div>
            <input
              type="text"
              placeholder="optional"
              .value=${this.channel}
              @input=${e=>{this.channel=e.target.value}}
            />
          </div>
        </div>

        <div class="row-group">
          <div class="row-item field-row">
            <div class="label">Author</div>
            <input
              type="text"
              placeholder="optional"
              .value=${this.authorName}
              @input=${e=>{this.authorName=e.target.value}}
            />
          </div>
        </div>

        <div class="row-group">
          <div class="row-item field-row">
            <div class="label">Recipient</div>
            <input
              type="text"
              placeholder="optional"
              .value=${this.recipient}
              @input=${e=>{this.recipient=e.target.value}}
            />
          </div>
        </div>

        <div class="row-group">
          <div class="row-item">
            <button
              class="text-button"
              @click=${()=>{this.saveButtonClick()}}
            >
              <span class="svg-icon">${o(d)}</span>Save
            </button>
            <button
              class="text-button"
              @click=${()=>{this.cancelButtonClick()}}
            >
              <span class="svg-icon">${o(r)}</span>Cancel
            </button>
          </div>
        </div>
      </div>
    `}};g.styles=[t`
      ${e(p)}
    `],m([s({attribute:!1})],g.prototype,"message",2),m([i()],g.prototype,"selectedRole",2),m([i()],g.prototype,"authorName",2),m([i()],g.prototype,"recipient",2),m([i()],g.prototype,"channel",2),g=m([a("euphony-message-editor-popover")],g);export{g as EuphonyMessageEditorPopover};