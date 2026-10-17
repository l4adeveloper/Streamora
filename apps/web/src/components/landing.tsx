"use client";
import Link from "next/link";

import {
  ArrowRight,
  ChevronDown,
  Clock3,
  Play,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  Waves,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";

import { Brand } from "./ui";
import { Presentation } from "./presentation";
export function Landing() {
  return (
    <main className="landing">
      <nav className="landing-nav">
        <Brand />
        <div className="landing-links">
          <a href="#trai-nghiem">Trải nghiệm</a>
          <a href="#khong-gian">Không gian học tập</a>
          <Link href="/meet">Tham gia cuộc họp</Link>
        </div>
        <Link className="button secondary" href="/workspace">
          Mở không gian <ArrowUpRight />
        </Link>
      </nav>
      <section className="hero">
        <div className="hero-orbit" />
        <div className="eyebrow">
          <span className="status-dot" /> MỘT KHÔNG GIAN. MỌI KẾT NỐI.
        </div>
        <h1>
          Cùng học. Cùng tạo.
          <br />
          <span>Không bỏ lỡ điều gì.</span>
        </h1>
        <p>
          Nơi cộng đồng gặp gỡ, ý tưởng được chia sẻ và mỗi buổi học
          <br className="desktop-break" /> luôn ở lại — ngay cả khi bạn đến
          muộn.
        </p>
        <div className="hero-actions">
          <Link className="button primary" href="/workspace">
            Khám phá không gian <ArrowRight size={18} />
          </Link>
          <Link className="button secondary" href="/meet">
            <Video size={18} /> Tạo cuộc họp
          </Link>
        </div>
        <div className="hero-note">
          <ShieldCheck size={14} /> Không gian của bạn, kết nối theo cách của
          bạn.
        </div>
        <Link
          href="/workspace"
          className="landing-preview"
          aria-label="Khám phá phòng học trực tiếp"
        >
          <div className="preview-chrome">
            <span />
            <span />
            <span />
            <div>streamora / cộng đồng / phòng học trực tiếp</div>
            <ShieldCheck size={14} />
          </div>
          <div className="preview-body">
            <aside>
              <span className="brand brand-small">
                <span className="brand-mark">
                  <Waves size={25} />
                </span>
              </span>
              <span className="community-icon mini">HT</span>
              <Plus size={20} />
            </aside>
            <div className="preview-channels">
              <b>
                Hệ thống phân tán <ChevronDown size={14} />
              </b>
              <small>KHÔNG GIAN HỌC TẬP</small>
              <span># &nbsp; trò-chuyện-chung</span>
              <span># &nbsp; hỏi-đáp</span>
              <small>ĐANG DIỄN RA</small>
              <span className="selected">
                <Radio size={15} /> Lớp học trực tiếp
              </span>
              <div className="preview-online">
                <span className="status-dot" /> 24 thành viên đang học
              </div>
            </div>
            <div className="preview-stage">
              <div className="preview-title">
                <Radio size={17} /> Lớp học trực tiếp{" "}
                <span className="live-badge">TRỰC TIẾP</span>
              </div>
              <Presentation />
              <div className="preview-dvr">
                <span className="mock-playhead" />
                <span />
              </div>
              <div className="preview-controls">
                <Play size={15} />
                <span>26:34 / 42:18</span>
                <b>
                  <Radio size={13} /> Về trực tiếp
                </b>
              </div>
            </div>
          </div>
          <div className="floating-note">
            <span>
              <Clock3 size={22} />
            </span>
            <div>
              <b>Đến muộn? Cứ thong thả.</b>
              <small>Tua lại mà không gián đoạn buổi học.</small>
            </div>
            <CheckCircle2 size={18} />
          </div>
        </Link>
      </section>
      <section id="trai-nghiem" className="landing-features">
        <div>
          <span className="eyebrow">KẾT NỐI THEO CÁCH CỦA BẠN</span>
          <h2>Một nơi cho cả hành trình học.</h2>
        </div>
        <div className="feature-grid">
          <article>
            <div className="feature-icon">
              <Users />
            </div>
            <h3>Cộng đồng luôn kết nối</h3>
            <p>
              Những cuộc trò chuyện có nơi để tiếp tục. Tổ chức nhóm, kênh học
              và tài liệu trong cùng một không gian.
            </p>
          </article>
          <article>
            <div className="feature-icon cyan">
              <Clock3 />
            </div>
            <h3>Trực tiếp, theo nhịp của bạn</h3>
            <p>
              Tua về khoảnh khắc cần xem lại, tăng tốc đến 2× và quay về trực
              tiếp chỉ với một chạm.
            </p>
          </article>
          <article>
            <div className="feature-icon peach">
              <Video />
            </div>
            <h3>Gặp nhau là bắt đầu</h3>
            <p>
              Tạo phòng, chia sẻ màn hình và cùng thảo luận. Mỗi ý tưởng đều có
              cơ hội được lắng nghe.
            </p>
          </article>
        </div>
      </section>
      <section id="khong-gian" className="landing-cta">
        <Sparkles size={28} />
        <h2>Buổi học tiếp theo bắt đầu ở đây.</h2>
        <Link className="button primary" href="/meet">
          Tạo cuộc họp đầu tiên <ArrowRight size={18} />
        </Link>
        <small>Bản trải nghiệm giao diện · Dữ liệu cộng đồng minh họa</small>
      </section>
      <footer className="landing-footer">
        <Brand />
        <span>Không gian chung. Khả năng vô hạn.</span>
        <span>© 2026 Streamora</span>
      </footer>
    </main>
  );
}
function ArrowUpRight() {
  return <ExternalLink size={15} />;
}
