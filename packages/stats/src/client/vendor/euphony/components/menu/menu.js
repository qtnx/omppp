import{v as t,i as e,n as s,r as i,a as n,b as o,x as r,w as a}from"../../chunks/third-party.js";import{c as u}from"../../chunks/css/menu.js";var d=Object.defineProperty,c=Object.getOwnPropertyDescriptor,m=(t,e,s,i)=>{for(var n,o=i>1?void 0:i?c(e,s):e,r=t.length-1;r>=0;r--)(n=t[r])&&(o=(i?n(e,s,o):n(o))||o);return i&&o&&d(e,s,o),o};let h=class extends n{constructor(){super(),this.menuItems=[],this.isHidden=!0,this.timer=null}willUpdate(t){}async initData(){}show(){this.isHidden&&(this.isHidden=!1)}hide(){if(this.isHidden)return;if(null===this.shadowRoot)throw Error("Shadow root is null");const t=this.shadowRoot.querySelector(".menu");if(!t)throw Error("Menu element not found");t.animate({opacity:[1,0]},{duration:200,easing:"ease-in-out"}).onfinish=()=>{this.isHidden=!0}}menuItemClicked(t,e){t.stopPropagation(),t.preventDefault();const s=new CustomEvent("menu-item-clicked",{bubbles:!0,composed:!0,detail:e});this.dispatchEvent(s)}render(){let t=o``;for(const[e,s]of this.menuItems.entries()){const e=s.name,i=s.icon;t=o`${t}<button
          class="menu-item"
          @click=${t=>{this.menuItemClicked(t,e)}}
        >
          <span class="svg-icon">${r(i)}</span>
          ${e}
        </button>`}return o` <div class="menu">${t}</div> `}};h.styles=[e`
      ${t(u)}
    `],m([s({type:Array,attribute:!1})],h.prototype,"menuItems",2),m([i()],h.prototype,"isHidden",2),h=m([a("nightjar-menu")],h);export{h as NightjarMenu};