import{v as o,i as t,n as e,e as i,a as s,b as p,x as r,w as n}from"../../chunks/third-party.js";import{u as l}from"../../chunks/utils.js";import{c as a}from"../../chunks/css/floating-toolbar.js";var u=Object.defineProperty,c=Object.getOwnPropertyDescriptor,h=(o,t,e,i)=>{for(var s,p=i>1?void 0:i?c(t,e):t,r=o.length-1;r>=0;r--)(s=o[r])&&(p=(i?s(t,e,p):s(p))||p);return i&&p&&u(t,e,p),p};const d=5;let b=class extends s{constructor(){super(),this.buttons=[],this.disappearTimeout=null,this.lastAnchor=null,this.toolbarTooltipDebouncer=null}firstUpdated(){}willUpdate(o){}async initData(){}updateCurrentTooltip(o){if(!this.popperTooltip)return void console.error("Popper tooltip not initialized.");if(!this.lastAnchor)return void console.warn("Last anchor not initialized.");const t=this.lastAnchor;this.popperTooltip.querySelector(".popper-label").textContent=o,l(this.popperTooltip,t,"top",!0,5)}toolButtonMouseEnter(o,t){if(o.stopPropagation(),o.preventDefault(),!this.popperTooltip)return void console.error("Popper tooltip not initialized.");const e=o.currentTarget;this.lastAnchor=e,this.toolbarTooltipDebouncer&&clearTimeout(this.toolbarTooltipDebouncer),this.toolbarTooltipDebouncer=window.setTimeout(()=>{const o=this.popperTooltip.querySelector(".popper-label");let i="Button";const s=this.buttons.find(o=>o.name===t);s?(i=s.tooltip,o.textContent=i,l(this.popperTooltip,e,"top",!0,5),this.popperTooltip.classList.remove("hidden")):console.error(`Button ${t} not found.`)},500)}toolButtonMouseLeave(o=!0){this.popperTooltip?(this.toolbarTooltipDebouncer&&(clearTimeout(this.toolbarTooltipDebouncer),this.toolbarTooltipDebouncer=null),o?this.popperTooltip.classList.add("hidden"):(this.popperTooltip.classList.add("no-transition"),this.popperTooltip.classList.add("hidden"),setTimeout(()=>{this.popperTooltip.classList.remove("no-transition")},150))):console.error("popperTooltip are not initialized yet.")}toolbarMouseEnter(){null!==this.disappearTimeout&&(clearTimeout(this.disappearTimeout),this.disappearTimeout=null)}toolbarMouseLeave(){const o=new Event("mouseleave",{bubbles:!0,composed:!0});this.dispatchEvent(o)}render(){const o=p`
      <div
        id="popper-tooltip"
        class="popper-tooltip hidden"
        role="tooltip"
        @click=${o=>{o.stopPropagation()}}
      >
        <div class="popper-content">
          <span class="popper-label">Hello</span>
        </div>
        <div class="popper-arrow"></div>
      </div>
    `;let t=p``;for(const o of this.buttons)t=p`${t}
        <button
          class="icon svg-icon ${o.name}-button"
          @mouseenter=${t=>{this.toolButtonMouseEnter(t,o.name)}}
          @mouseleave=${()=>{this.toolButtonMouseLeave()}}
          @click=${t=>{const e=new CustomEvent("button-clicked",{bubbles:!0,composed:!0,detail:o.name});this.dispatchEvent(e)}}
        >
          ${r(o.svgIcon)}
        </button> `;return p`
      ${o}
      <div
        class="floating-toolbar"
        @mouseenter=${()=>{this.toolbarMouseEnter()}}
        @mouseleave=${()=>{this.toolbarMouseLeave()}}
      >
        ${t}
      </div>
    `}};b.styles=[t`
      ${o(a)}
    `],h([e({attribute:!1})],b.prototype,"buttons",2),h([e({})],b.prototype,"disappearTimeout",2),h([i("#popper-tooltip")],b.prototype,"popperTooltip",2),b=h([n("euphony-floating-toolbar")],b);export{b as EuphonyFloatingToolbar};